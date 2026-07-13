// Client-centric one-time match queue (the mirror of lib/grants/queue.ts).
//
// The matcher is grant-centric (runMatching = one grant -> the active roster,
// which fits one 300s function because the roster is small). A prospect's one-time
// match is the OPPOSITE orientation -- one client -> the whole grant pool (~45) --
// and that does NOT fit one function: 45 token-heavy Sonnet calls blow past 300s
// (observed timeout, 2026-07-13). So it is drained pair-by-pair, resumably, across
// as many short invocations as the pool needs.
//
// Resume needs NO cursor and NO new table: match_attempts already logs every
// (grant, client) scoring attempt, so "remaining" is derived by diffing the pool
// against the attempts already recorded for the client. This is self-healing --
// every pair either cards or errors, both of which write an attempt row, so
// remaining shrinks monotonically to zero and the client always reaches
// 'complete' even if individual pairs fail or an invocation is killed mid-run.
//
// Lifecycle on clients.initial_match_status (plain text, no enum, no migration):
//   queued   -> enqueued at prospect insert (createClientAction), awaiting a drain
//   running  -> a drain has started scoring it (persists across invocations)
//   complete -> the WHOLE pool has an attempt for this client (set here, last)
//   error    -> a hard load failure (pool/client fetch). Per-pair failures are
//               NOT errors -- they are recorded attempts and count as done.
// Invariant (matches the grant queue): 'complete' is reached ONLY when every pool
// grant has been attempted -- never a silent partial.

import { createServiceClient } from "@/lib/supabase/server";
import { scoreGrantClientPair } from "@/lib/grants/pipeline";
import type { Client, Grant } from "@/types/database";

type DB = ReturnType<typeof createServiceClient>;

// Hard deadline for a single invocation, well under the 300s function cap. The
// drain returns AT this deadline no matter what (see scorePairsWithinBudget's
// race) -- a pair stuck in 429 backoff can't drag the invocation to the 300s kill.
// 210s leaves ~90s of headroom for the response + any straggler the platform
// drains; the cron/resume finishes whatever this invocation didn't.
const DEFAULT_BUDGET_MS = 210_000;

// Below runMatching's 8: 45 concurrent pool calls in one window is what tripped
// the rate-limit backoff that ballooned wall-clock. 6 keeps throughput up while
// staying under the per-minute ceiling; the drain resumes next tick regardless.
const CONCURRENCY = 6;

export type ClientDrainResult = {
  advanced: string[]; // clients that had pairs scored this run
  completed: string[]; // clients that reached 'complete' this run
  errored: { id: string; error: string }[];
  budgetExhausted: boolean;
  queueEmpty: boolean;
};

// The scorable pool: grants that reached Stage A (an ideal_applicant_profile was
// built). A grant with no profile is never scored by the daily batch either, so
// scoring it here would waste calls and mint nothing. Mirrors willScore.
async function loadPool(db: DB): Promise<Grant[]> {
  const { data, error } = await db
    .from("grants")
    .select("*")
    .not("ideal_applicant_profile", "is", null);
  if (error) throw new Error(`Pool load failed: ${error.message}`);
  return (data ?? []) as Grant[];
}

// Grant ids already attempted for this client (any outcome counts as done).
async function scoredGrantIds(db: DB, clientId: string): Promise<Set<string>> {
  const { data, error } = await db
    .from("match_attempts")
    .select("grant_id")
    .eq("client_id", clientId);
  if (error) throw new Error(`Attempt lookup failed: ${error.message}`);
  return new Set((data ?? []).map((r) => r.grant_id as string));
}

// Score (grant, client) pairs with a bounded rolling pool. TWO stops, both needed:
//   1. Each worker refuses to CLAIM a new pair once the deadline passes.
//   2. The whole batch is RACED against the deadline, so a slow in-flight pair
//      (typically one stuck in 429 backoff) can never hold the invocation past
//      budget. Stop 1 alone was the bug: `await Promise.all(...)` waited for the
//      in-flight wave, and a backoff-laden straggler ran past the 300s cap and was
//      killed before the drain could return budgetExhausted.
// An abandoned in-flight pair is caught inside scoreGrantClientPair (no unhandled
// rejection) and simply re-scored on the next resume -- the attempts-diff makes
// that safe. Returns pairs actually finished + peak concurrency observed, so a run
// can confirm the pool is genuinely parallel (peak ~= CONCURRENCY) rather than
// effectively serialized by rate-limit backoff (peak collapsing toward 1).
async function scorePairsWithinBudget(
  db: DB,
  client: Client,
  pairs: Grant[],
  deadlineMs: number,
): Promise<{ completed: number; peakInFlight: number }> {
  let nextIdx = 0;
  let inFlight = 0;
  let peakInFlight = 0;
  let completed = 0;
  const worker = async () => {
    while (Date.now() < deadlineMs) {
      const i = nextIdx++;
      if (i >= pairs.length) return;
      inFlight++;
      if (inFlight > peakInFlight) peakInFlight = inFlight;
      try {
        await scoreGrantClientPair(pairs[i], client, db);
        completed++;
      } finally {
        inFlight--;
      }
    }
  };
  const workers = Promise.all(
    Array.from({ length: Math.min(CONCURRENCY, pairs.length) }, worker),
  );
  // Hard stop: resolve at the deadline even if in-flight pairs are still running.
  // Clear the timer if the workers win the race so a fast run doesn't keep the
  // event loop (and the billed function) alive until the deadline fires.
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, Math.max(0, deadlineMs - Date.now()));
  });
  try {
    await Promise.race([workers, deadline]);
  } finally {
    if (timer) clearTimeout(timer);
  }
  return { completed, peakInFlight };
}

/**
 * Drain the client one-time-match queue: score enqueued prospects against the
 * grant pool, pair by pair, until the queue is empty or the time budget is spent.
 * Resumable and self-healing (see file header). Returns a summary for the cron
 * response / observability.
 */
export async function drainClientMatchQueue(
  db: DB,
  opts?: { budgetMs?: number },
): Promise<ClientDrainResult> {
  const budgetMs = opts?.budgetMs ?? DEFAULT_BUDGET_MS;
  const startedAt = Date.now();
  const deadlineMs = startedAt + budgetMs;
  const advanced: string[] = [];
  const completed: string[] = [];
  const errored: { id: string; error: string }[] = [];
  let budgetExhausted = false;
  let queueEmpty = false;
  // Observability: total pairs finished this invocation and the peak concurrency
  // observed. Logged once at the end -- the ratio of pairs to wall-clock, plus
  // peak, reveals whether the pool is genuinely parallel or throttled to ~1.
  let totalScored = 0;
  let peakInFlight = 0;

  // Pool is stable for the whole drain -- load it once.
  let pool: Grant[];
  try {
    pool = await loadPool(db);
  } catch (err) {
    return {
      advanced,
      completed,
      errored: [{ id: "pool", error: String(err instanceof Error ? err.message : err).slice(0, 300) }],
      budgetExhausted: false,
      queueEmpty: false,
    };
  }

  while (true) {
    if (Date.now() >= deadlineMs) {
      budgetExhausted = true;
      break;
    }

    // Oldest waiting client first. 'queued' = never started; 'running' = started by
    // a prior invocation and resuming. created_at orders the queue.
    const { data: candidate } = await db
      .from("clients")
      .select("*")
      .in("initial_match_status", ["queued", "running"])
      .order("created_at", { ascending: true })
      .limit(1)
      .maybeSingle<Client>();
    if (!candidate) {
      queueEmpty = true;
      break;
    }

    try {
      const done = await scoredGrantIds(db, candidate.id);
      const remaining = pool.filter((g) => !done.has(g.id));

      if (remaining.length === 0) {
        // Nothing left (pool empty, or a prior invocation finished it) -> land it.
        await db.from("clients").update({ initial_match_status: "complete" }).eq("id", candidate.id);
        completed.push(candidate.id);
        continue;
      }

      // Claim: mark 'running' so the dashboard banner reflects active work.
      await db.from("clients").update({ initial_match_status: "running" }).eq("id", candidate.id);
      const { completed: pairsDone, peakInFlight: peak } = await scorePairsWithinBudget(
        db,
        candidate,
        remaining,
        deadlineMs,
      );
      totalScored += pairsDone;
      if (peak > peakInFlight) peakInFlight = peak;
      advanced.push(candidate.id);

      // Re-derive after scoring: if the whole pool is now attempted, complete it;
      // otherwise leave it 'running' for the next invocation to resume.
      const doneNow = await scoredGrantIds(db, candidate.id);
      const stillRemaining = pool.some((g) => !doneNow.has(g.id));
      if (!stillRemaining) {
        await db.from("clients").update({ initial_match_status: "complete" }).eq("id", candidate.id);
        completed.push(candidate.id);
      } else {
        // Budget must be spent (scorePairsWithinBudget only returns early on the
        // deadline). Stop so we don't spin re-picking the same client.
        budgetExhausted = true;
        break;
      }
    } catch (err) {
      // A hard failure (attempt lookup / claim) -> mark 'error' and move on. Per-
      // pair failures never reach here (scoreGrantClientPair swallows them).
      const detail = String(err instanceof Error ? err.message : err).slice(0, 300);
      console.error(`Client match drain error for ${candidate.id}:`, err);
      await db.from("clients").update({ initial_match_status: "error" }).eq("id", candidate.id);
      errored.push({ id: candidate.id, error: detail });
    }
  }

  const wallMs = Date.now() - startedAt;
  console.log(
    `[client-match-timing] scoredPairs=${totalScored} peakInFlight=${peakInFlight}/${CONCURRENCY} ` +
      `wallMs=${wallMs} budgetMs=${budgetMs} budgetExhausted=${budgetExhausted} ` +
      `advancedClients=${advanced.length} completedClients=${completed.length}`,
  );

  return { advanced, completed, errored, budgetExhausted, queueEmpty };
}
