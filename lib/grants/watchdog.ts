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
  clientMatchRequeued: number;
  grantIds: { processing: string[]; requeued: string[]; matchingErrored: string[] };
  clientIds: { matchRequeued: string[] };
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

  // 4) Dead CLIENT one-time-match runs (lib/clients/match-queue.ts). The drain marks
  //    a client 'running' and renews its lease (match_locked_at) every ~25s while
  //    scoring; a clean stop / the client-match cron resumes a stopped one within
  //    ~10 min. A record still 'running' with NO update in STUCK_THRESHOLD_MINUTES
  //    means BOTH the drain and that cron failed to touch it -- a genuinely dead run
  //    (the exact stuck-'running' dead-end that otherwise needed a manual SQL reset).
  //    Requeue it (clear the lease) so the next cron / dashboard continuation round
  //    resumes it. No retry cap: the attempts-diff makes the re-drain idempotent and
  //    every resume makes monotonic progress to 'complete', so requeue can't loop
  //    forever burning calls the way an unmatchable grant could. Bulk + returning,
  //    guarded on status='running' so a drain that just finished isn't clobbered.
  const { data: stuckClientMatch } = await db
    .from("clients")
    .update({ initial_match_status: "queued", match_locked_at: null })
    .eq("initial_match_status", "running")
    .lt("updated_at", cutoff)
    .select("id");
  const clientMatchRequeued = (stuckClientMatch ?? []).map((c) => c.id as string);

  const sweptProcessingIds = (sweptProcessing ?? []).map((g) => g.id);
  if (sweptProcessingIds.length || requeued.length || matchingErrored.length || clientMatchRequeued.length) {
    console.log(
      `Watchdog: processing->error ${sweptProcessingIds.length}, matching->requeued ${requeued.length}, ` +
        `matching->error ${matchingErrored.length}, client-match->requeued ${clientMatchRequeued.length}`,
    );
  }

  return {
    sweptProcessing: sweptProcessingIds.length,
    matchingRequeued: requeued.length,
    matchingErrored: matchingErrored.length,
    queuedBacklog: queuedCount,
    oldestQueuedMinutes,
    clientMatchRequeued: clientMatchRequeued.length,
    grantIds: { processing: sweptProcessingIds, requeued, matchingErrored },
    clientIds: { matchRequeued: clientMatchRequeued },
  };
}
