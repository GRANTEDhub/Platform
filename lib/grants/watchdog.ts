// Stuck-pipeline watchdog sweep (shared by the cron and the admin trigger).
//
// Turns every SILENTLY dead in-flight grant into a visible, recoverable state.
// See the route comments for the full rationale. Measures "stuck" from
// processing_started_at (migration 0039); NULL is never swept (.lt excludes it).

import { createServiceClient } from "@/lib/supabase/server";
import { MATCH_MAX_RETRIES } from "@/lib/grants/queue";

type DB = ReturnType<typeof createServiceClient>;

const STUCK_THRESHOLD_MINUTES = 15; // comfortably above the 300s function cap
const QUEUED_BACKLOG_WARN_MINUTES = 60; // drain runs every 10 min -> older = behind/down

export type WatchdogResult = {
  sweptProcessing: number;
  matchingRequeued: number;
  matchingErrored: number;
  queuedBacklog: number;
  oldestQueuedMinutes: number;
  grantIds: { processing: string[]; requeued: string[]; matchingErrored: string[] };
};

export async function runWatchdogSweep(db: DB): Promise<WatchdogResult> {
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
  if (procErr) throw new Error(`Watchdog processing sweep failed: ${procErr.message}`);

  // 2) Dead MATCHING runs (the queue drain died mid-match). Per-row decision --
  //    requeue if retry budget remains, else visible error -- so we cannot do a
  //    single bulk update (and the JS client can't express match_retry_count + 1).
  //    Volume is tiny (a stale 'matching' grant is rare), so a per-row loop is fine.
  const { data: stuckMatching, error: matchErr } = await db
    .from("grants")
    .select("id, match_retry_count")
    .eq("status", "matching")
    .lt("processing_started_at", cutoff);
  if (matchErr) throw new Error(`Watchdog matching sweep failed: ${matchErr.message}`);

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

  return {
    sweptProcessing: sweptProcessingIds.length,
    matchingRequeued: requeued.length,
    matchingErrored: matchingErrored.length,
    queuedBacklog: queuedCount,
    oldestQueuedMinutes,
    grantIds: { processing: sweptProcessingIds, requeued, matchingErrored },
  };
}
