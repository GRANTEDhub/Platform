// Per-grant matching queue (Move 2).
//
// Roster matching is split OUT of the ingest/discovery hot path into a DB-backed
// queue: a grant that needs matching is parked at status='queued', and a cron
// drains the queue ONE GRANT AT A TIME, cradle-to-grave, sequentially within a
// per-invocation time budget. No parallel fan-out across grants, no self-firing
// chain -- the failure-prone speed optimizations are gone. Same-day throughput is
// plenty, and one-at-a-time means a run can never overload the 300s window.
//
// Why this exists: the discovery cron used to run up to 25 full shred+match
// pipelines inside ONE 300s function. It reliably timed out partway, leaving
// grants stuck in 'processing' that the watchdog later flipped to 'error' with a
// generic message -- a SILENT partial-match (missing cards, nobody watching).
//
// Lifecycle on grants.status (a plain text column -- no enum, no migration):
//   queued   -> waiting for the drain
//   matching -> the drain has claimed it and is running its pipeline
//   complete -> the WHOLE roster finished (set by runPipeline / runMatching)
//   error    -> a thrown failure, or the watchdog giving up after capped retries
// Invariant: a grant reaches 'complete' ONLY when the full roster finished
// (runMatching sets it as its last line). 'complete' is never a silent partial.

import { createServiceClient } from "@/lib/supabase/server";
import { runPipeline, runMatching } from "@/lib/grants/pipeline";

type DB = ReturnType<typeof createServiceClient>;

// Leave headroom under the 300s function cap: stop claiming new grants once this
// much wall-clock is spent, so an in-flight grant's match finishes comfortably.
const DEFAULT_BUDGET_MS = 240_000;

// Capped requeues of a KILLED match (no thrown error) before the watchdog gives
// up and flips the grant to a visible 'error'. Read/enforced by the watchdog
// (Stage 4); reset to 0 by enqueueMatch so every episode starts with a full budget.
export const MATCH_MAX_RETRIES = 2;

export type DrainResult = {
  processed: string[];
  errored: { id: string; error: string }[];
  budgetExhausted: boolean;
  queueEmpty: boolean;
};

/**
 * Park a grant in the matching queue. Resets the retry budget so every matching
 * episode (new discovery / forecast->posted flip / manual re-queue) starts fresh,
 * and clears any stale error_detail from a prior run.
 *
 * Wired into the discovery cron in Stage 3. Until then a grant is enqueued by
 * hand (`update grants set status='queued' where id=...`) to test the drain.
 */
export async function enqueueMatch(db: DB, grantId: string): Promise<void> {
  await db
    .from("grants")
    .update({ status: "queued", match_retry_count: 0, error_detail: null })
    .eq("id", grantId);
}

/**
 * Drain the matching queue sequentially -- one grant cradle-to-grave -- until the
 * queue is empty or the time budget is spent. Never runs two grants' matches at
 * once. Returns a summary for the cron response / observability.
 */
export async function drainMatchQueue(
  db: DB,
  opts?: { budgetMs?: number },
): Promise<DrainResult> {
  const budgetMs = opts?.budgetMs ?? DEFAULT_BUDGET_MS;
  const startedAt = Date.now();
  const processed: string[] = [];
  const errored: { id: string; error: string }[] = [];
  let budgetExhausted = false;
  let queueEmpty = false;

  while (true) {
    if (Date.now() - startedAt >= budgetMs) {
      budgetExhausted = true;
      break;
    }

    // Pick the oldest queued grant. ingested_at orders the queue; a forecast->posted
    // flip carries an old ingested_at, so a freshly-live grant is processed
    // promptly -- matching the discovery cron's existing "flips first" intent.
    const { data: candidate } = await db
      .from("grants")
      .select("id, source_url, shred_depth")
      .eq("status", "queued")
      .order("ingested_at", { ascending: true })
      .limit(1)
      .maybeSingle<{ id: string; source_url: string | null; shred_depth: string | null }>();
    if (!candidate) {
      queueEmpty = true;
      break;
    }

    // Optimistic claim: flip queued -> matching guarded on it STILL being queued.
    // An overlapping drain (a manual trigger racing the schedule) can then never
    // double-run the same grant -- the loser's update matches 0 rows and we retry
    // the loop. processing_started_at anchors the watchdog's stall detection.
    const { data: claimed } = await db
      .from("grants")
      .update({ status: "matching", processing_started_at: new Date().toISOString() })
      .eq("id", candidate.id)
      .eq("status", "queued")
      .select("id");
    if (!claimed || claimed.length === 0) continue;

    try {
      // Cradle-to-grave for this one grant. A grant that has never been shredded
      // (a fresh discovery row: shred_depth null) gets the FULL pipeline
      // (shred -> profile -> match); an already-shredded grant (a re-queue / retry
      // / manual test) skips straight to matching -- no wasteful re-shred. Both
      // set status='complete' on success, so the drain never sets it: a grant
      // reaches 'complete' only when matching actually finished.
      if (candidate.shred_depth == null) {
        await runPipeline(candidate.id, candidate.source_url ?? undefined, undefined, db);
      } else {
        await runMatching(candidate.id, db);
      }
      processed.push(candidate.id);
    } catch (err) {
      // A THROWN failure is a real error -> visible immediately, no retry. (The
      // capped-retry path is for a KILLED run that never threw -- the drain died
      // with it -- which the watchdog detects via a stale 'matching' + heartbeat.)
      const detail = String(err instanceof Error ? err.message : err).slice(0, 600);
      console.error(`Match drain error for grant ${candidate.id}:`, err);
      await db
        .from("grants")
        .update({ status: "error", error_detail: detail })
        .eq("id", candidate.id);
      errored.push({ id: candidate.id, error: detail });
    }
  }

  return { processed, errored, budgetExhausted, queueEmpty };
}
