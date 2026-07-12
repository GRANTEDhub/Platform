// Stuck-pipeline watchdog — runs on a Vercel Cron schedule.
//
// The shred+score pipeline runs as background work on a function capped at 300s.
// If the function is KILLED (timeout, OOM, instance recycle, deploy mid-run) the
// process dies with NO thrown error and the grant is left mid-flight forever --
// an invisible dead-end (observed 2026-06-27). This sweep turns every such dead
// state into a visible, recoverable one. It measures "stuck" from
// processing_started_at (migration 0039) -- when the CURRENT run started, not the
// once-set ingested_at -- so a legitimate ~5-min run gets its full window while a
// genuinely dead run is caught 15 min after it started. NULL processing_started_at
// is never swept (SQL .lt excludes nulls).
//
// Two in-flight shapes, both killed the same silent way:
//   status='processing' -> a shred (manual ingest / re-shred / re-match) died.
//                          Flip to 'error' (no retry -- a human kicked it and is
//                          watching; re-run is one click).
//   status='matching'   -> the matching-queue drain (Move 2) died mid-match. This
//                          is the AUTOMATIC path nobody watches, so retry it: bump
//                          match_retry_count and requeue (status='queued') up to
//                          MATCH_MAX_RETRIES, then give up to a visible 'error'.
//                          Retry converges because a re-drain is idempotent
//                          (skip-decided + per-(grant,client) card dedup).
// A grant sitting in 'queued' is NOT stuck -- it is waiting for the drain -- so it
// is never swept; but a growing/aging queue means the drain cron is behind or
// down, which must not be silent, so we log it (loudly past a threshold).

import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/server";
import { cronDeny } from "@/lib/cron/auth";
import { MATCH_MAX_RETRIES } from "@/lib/grants/queue";

export const dynamic = "force-dynamic";

const STUCK_THRESHOLD_MINUTES = 15; // comfortably above the 300s function cap
const QUEUED_BACKLOG_WARN_MINUTES = 60; // drain runs every 10 min -> older = behind/down

export async function GET(req: NextRequest) {
  const deny = cronDeny(req);
  if (deny) return deny;

  const db = createServiceClient();
  const cutoff = new Date(Date.now() - STUCK_THRESHOLD_MINUTES * 60 * 1000).toISOString();

  // 1) Dead SHRED runs (manual ingest / re-shred / re-match). Flip to 'error',
  //    no retry -- a human initiated it and can re-run in one click.
  const { data: sweptProcessing, error: procErr } = await db
    .from("grants")
    .update({
      status: "error",
      error_detail:
        "Stuck in processing (watchdog): pipeline did not complete -- the function likely timed out or was recycled. Re-ingest to retry.",
    })
    .eq("status", "processing")
    .lt("processing_started_at", cutoff)
    .select("id");
  if (procErr) {
    console.error("Watchdog processing sweep failed:", procErr.message);
    return NextResponse.json({ error: "Watchdog sweep failed" }, { status: 500 });
  }

  // 2) Dead MATCHING runs (the queue drain died mid-match). Per-row decision --
  //    requeue if retry budget remains, else visible error -- so we cannot do a
  //    single bulk update (and the JS client can't express match_retry_count + 1).
  //    Volume is tiny (a stale 'matching' grant is rare), so a per-row loop is fine.
  const { data: stuckMatching, error: matchErr } = await db
    .from("grants")
    .select("id, match_retry_count")
    .eq("status", "matching")
    .lt("processing_started_at", cutoff);
  if (matchErr) {
    console.error("Watchdog matching sweep failed:", matchErr.message);
    return NextResponse.json({ error: "Watchdog sweep failed" }, { status: 500 });
  }

  const requeued: string[] = [];
  const matchingErrored: string[] = [];
  for (const g of (stuckMatching ?? []) as { id: string; match_retry_count: number | null }[]) {
    const retries = g.match_retry_count ?? 0;
    // Guard every write on status='matching' so we never clobber a grant the drain
    // just finished (or re-claimed) between our select and this update.
    if (retries < MATCH_MAX_RETRIES) {
      const { data } = await db
        .from("grants")
        .update({ status: "queued", match_retry_count: retries + 1 })
        .eq("id", g.id)
        .eq("status", "matching")
        .select("id");
      if (data && data.length > 0) requeued.push(g.id);
    } else {
      const { data } = await db
        .from("grants")
        .update({
          status: "error",
          error_detail: `Matching did not complete after ${MATCH_MAX_RETRIES + 1} attempts (watchdog): the drain was repeatedly killed mid-match, or the roster now exceeds the single-run window. Re-match to retry.`,
        })
        .eq("id", g.id)
        .eq("status", "matching")
        .select("id");
      if (data && data.length > 0) matchingErrored.push(g.id);
    }
  }

  // 3) Queue-backlog visibility. A 'queued' grant is waiting, not stuck -- never
  //    error it -- but an aging queue means the drain is behind or down, which
  //    must be visible rather than silent.
  const { data: queued } = await db
    .from("grants")
    .select("id, ingested_at")
    .eq("status", "queued")
    .order("ingested_at", { ascending: true });
  let queuedCount = 0;
  let oldestQueuedMinutes = 0;
  if (queued && queued.length > 0) {
    queuedCount = queued.length;
    const oldest = (queued[0] as { ingested_at: string | null }).ingested_at;
    oldestQueuedMinutes = oldest
      ? Math.round((Date.now() - new Date(oldest).getTime()) / 60000)
      : 0;
    const msg = `Watchdog: ${queuedCount} grant(s) queued for matching, oldest ${oldestQueuedMinutes}min`;
    if (oldestQueuedMinutes > QUEUED_BACKLOG_WARN_MINUTES) {
      console.warn(`${msg} -- drain may be behind or DOWN`);
    } else {
      console.log(msg);
    }
  }

  const sweptProcessingIds = (sweptProcessing ?? []).map((g) => g.id);
  if (sweptProcessingIds.length || requeued.length || matchingErrored.length) {
    console.log(
      `Watchdog: processing->error ${sweptProcessingIds.length}, matching->requeued ${requeued.length}, matching->error ${matchingErrored.length}`,
    );
  }

  return NextResponse.json({
    sweptProcessing: sweptProcessingIds.length,
    matchingRequeued: requeued.length,
    matchingErrored: matchingErrored.length,
    queuedBacklog: queuedCount,
    oldestQueuedMinutes,
    grantIds: {
      processing: sweptProcessingIds,
      requeued,
      matchingErrored,
    },
  });
}
