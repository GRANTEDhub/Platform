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
import { isGrantOpen } from "@/lib/grants/lifecycle";
import type { Client, Grant } from "@/types/database";

type DB = ReturnType<typeof createServiceClient>;

// CLAIM-cutoff for a single invocation: workers stop claiming NEW pairs at this
// wall-clock. Well under the 300s function cap. The invocation actually returns a
// little later -- at cutoff + GRACE_MS -- so the in-flight wave can COMMIT before we
// hand off (see scorePairsWithinBudget / GRACE_MS). 210s + grace still leaves ample
// headroom under the 300s kill; the cron/resume finishes whatever didn't fit.
const DEFAULT_BUDGET_MS = 210_000;

// Grace window appended AFTER the claim-cutoff: workers stop claiming at the budget,
// but the invocation waits up to this long for the (<= CONCURRENCY) still-in-flight
// pairs to finish and write their attempts BEFORE returning. Without it, the hard
// race abandoned the whole in-flight wave every window boundary; those pairs then
// committed just after the next round had already read `done`, so the next round
// re-scored them -- duplicate attempts + double LLM spend (~CONCURRENCY per boundary).
// Draining the wave here means each round commits everything it dispatched before the
// next round computes `remaining`, so there's no boundary re-score. The race is still
// HARD-bounded at cutoff + GRACE_MS, so a 429-backoff straggler can't drag us to the
// 300s kill (it's abandoned past the grace -- the rare, bounded residual). Sized so
// budget + grace stays under BOTH caps: the interactive round (65s budget) + 25s =
// 90s < Cloudflare's ~100s origin limit; the cron (210s) + 25s = 235s < 300s.
const GRACE_MS = 25_000;

// Below runMatching's 8: 45 concurrent pool calls in one window is what tripped
// the rate-limit backoff that ballooned wall-clock. 6 keeps throughput up while
// staying under the per-minute ceiling; the drain resumes next tick regardless.
const CONCURRENCY = 6;

// Concurrency lease (migration 0049, clients.match_locked_at). A drain CLAIMS a
// client by setting match_locked_at=now() and RENEWS it every RENEW_INTERVAL_MS
// while scoring; another drain skips a client whose lease is younger than
// LEASE_TTL_MS. This serializes drains per client so the client-driven continuation
// loop, the 10-min cron, and a second browser tab never score the same pool at once
// (no double LLM spend). A dead drain's lease expires after LEASE_TTL_MS, so the
// record is reclaimable -- never permanently stuck. RENEW is well under TTL (3x
// headroom) so a live drain never lets its own lease lapse.
const LEASE_TTL_MS = 90_000;
const RENEW_INTERVAL_MS = 25_000;

// A claimable record is one whose lease is null or older than LEASE_TTL_MS. Built as
// a PostgREST or-filter. The expiry timestamp is emitted WITHOUT milliseconds so it
// carries no '.' -- PostgREST splits an or-condition on '.' (column.op.value), and a
// millisecond '.' in the value would mis-parse; ':' and 'T'/'Z' are not separators,
// so the trimmed ISO string is safe unquoted.
function leaseClaimableFilter(): string {
  const expiry = new Date(Date.now() - LEASE_TTL_MS).toISOString().replace(/\.\d{3}Z$/, "Z");
  return `match_locked_at.is.null,match_locked_at.lt.${expiry}`;
}

export type ClientDrainResult = {
  advanced: string[]; // clients that had pairs scored this run
  completed: string[]; // clients that reached 'complete' this run
  errored: { id: string; error: string }[];
  budgetExhausted: boolean;
  queueEmpty: boolean;
};

// The scorable pool: grants that reached Stage A (an ideal_applicant_profile was
// built) AND are still OPEN. A grant with no profile is never scored by the daily
// batch either, so scoring it here would waste calls and mint nothing (mirrors
// willScore); a CLOSED grant (deadline strictly in the past) must never surface on
// a report as if open. The open/closed cut uses the shared lifecycle classifier
// (null-safe: null/today/future deadlines stay in) rather than an inline predicate,
// so the tier logic reuses the same rule.
async function loadPool(db: DB): Promise<Grant[]> {
  const { data, error } = await db
    .from("grants")
    .select("*")
    .not("ideal_applicant_profile", "is", null);
  if (error) throw new Error(`Pool load failed: ${error.message}`);
  const now = new Date(); // one clock for the whole pool
  return ((data ?? []) as Grant[]).filter((g) => isGrantOpen(g, now));
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

// Score (grant, client) pairs with a bounded rolling pool. TWO deadlines:
//   1. CLAIM-cutoff (`deadlineMs`): each worker refuses to CLAIM a new pair once
//      this passes -- so we never START work we can't hope to finish in budget.
//   2. HARD-return (`deadlineMs + GRACE_MS`): the whole batch is RACED against this,
//      so a pair stuck in 429 backoff can never hold the invocation past the cap.
// The GRACE between them is the fix for the window-boundary cost leak: at the cutoff
// the <= CONCURRENCY in-flight pairs keep running and, given the grace, finish and
// COMMIT their attempts before this returns. So the round hands off with everything
// it dispatched already recorded -- the next round's `remaining` excludes them and
// nothing is re-scored. (Previously cutoff == hard-return, so the entire in-flight
// wave was abandoned every boundary and re-scored by the next round: duplicate
// attempts + double LLM spend.) Only a straggler that outlasts the grace is still
// abandoned -- the rare, bounded residual, surfaced as `abandonedAtCutoff`.
// Returns pairs finished, peak concurrency (peak ~= CONCURRENCY confirms real
// parallelism vs backoff serialization), and how many were still in flight when the
// hard-return fired (0 on a clean grace-drain).
async function scorePairsWithinBudget(
  db: DB,
  client: Client,
  pairs: Grant[],
  deadlineMs: number,
): Promise<{ completed: number; peakInFlight: number; abandonedAtCutoff: number }> {
  let nextIdx = 0;
  let inFlight = 0;
  let peakInFlight = 0;
  let completed = 0;

  // Keep our lease fresh while scoring so concurrent drains keep skipping this
  // client. Throttled to RENEW_INTERVAL_MS; the shared lastRenewAt is raced by the
  // workers but a double-renew is harmless. Best-effort: a failed renewal only
  // risks the lease lapsing early, which is safe (attempts-diff => idempotent).
  let lastRenewAt = Date.now();
  const renewLease = async () => {
    const now = Date.now();
    if (now - lastRenewAt < RENEW_INTERVAL_MS) return;
    lastRenewAt = now;
    await db.from("clients").update({ match_locked_at: new Date(now).toISOString() }).eq("id", client.id);
  };

  const worker = async () => {
    while (Date.now() < deadlineMs) {
      await renewLease();
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
  // Hard-return at cutoff + GRACE_MS. Workers stop CLAIMING at deadlineMs (their while
  // check); the extra grace lets the in-flight wave finish and commit before we return,
  // so the next round doesn't re-score it. If a straggler outlasts the grace the race
  // resolves here anyway, so we never blow the cap. Clear the timer if the workers win
  // so a fast run doesn't keep the billed function alive to the hard-return.
  let timer: ReturnType<typeof setTimeout> | undefined;
  const hardReturn = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, Math.max(0, deadlineMs + GRACE_MS - Date.now()));
  });
  try {
    await Promise.race([workers, hardReturn]);
  } finally {
    if (timer) clearTimeout(timer);
  }
  // Whatever is still running now (0 if the workers won the race) is what the grace
  // did NOT drain -- a straggler that will commit after we return and may be re-scored
  // by the next round. Surfaced for the timing log so the residual is observable.
  const abandonedAtCutoff = inFlight;
  return { completed, peakInFlight, abandonedAtCutoff };
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
  // Pairs still in flight when a window hit its hard-return (grace didn't drain them).
  // 0 on a clean run; a nonzero value is the re-score/dup-attempt residual to watch.
  let totalAbandoned = 0;

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

    // Oldest CLAIMABLE client first. 'queued' = never started; 'running' = a prior
    // invocation resuming. The lease filter excludes a client another drain is
    // actively scoring (fresh lease), so we never pick one that's already in flight;
    // a client with an expired/null lease is fair game (resume or dead-drain recovery).
    const { data: candidate } = await db
      .from("clients")
      .select("*")
      .in("initial_match_status", ["queued", "running"])
      .or(leaseClaimableFilter())
      .order("created_at", { ascending: true })
      .limit(1)
      .maybeSingle<Client>();
    if (!candidate) {
      // Nothing claimable: either the queue is empty, or every waiting client is
      // currently leased by another live drain. Either way this invocation is done.
      queueEmpty = true;
      break;
    }

    // Atomically CLAIM the lease: set 'running' + match_locked_at=now(), still guarded
    // on the lease being claimable. If another drain claimed it between the select and
    // here, this touches 0 rows -> skip to the next candidate rather than double-score.
    const { data: claimed } = await db
      .from("clients")
      .update({ initial_match_status: "running", match_locked_at: new Date().toISOString() })
      .eq("id", candidate.id)
      .in("initial_match_status", ["queued", "running"])
      .or(leaseClaimableFilter())
      .select("id");
    if (!claimed || claimed.length === 0) continue;

    try {
      const done = await scoredGrantIds(db, candidate.id);
      const remaining = pool.filter((g) => !done.has(g.id));

      if (remaining.length === 0) {
        // Nothing left (pool empty, or a prior invocation finished it) -> land it and
        // release the lease.
        await db
          .from("clients")
          .update({ initial_match_status: "complete", match_locked_at: null })
          .eq("id", candidate.id);
        completed.push(candidate.id);
        continue;
      }

      const { completed: pairsDone, peakInFlight: peak, abandonedAtCutoff } =
        await scorePairsWithinBudget(db, candidate, remaining, deadlineMs);
      totalScored += pairsDone;
      totalAbandoned += abandonedAtCutoff;
      if (peak > peakInFlight) peakInFlight = peak;
      advanced.push(candidate.id);

      // Re-derive after scoring: if the whole pool is now attempted, complete it;
      // otherwise release the lease and leave it 'running' so the next continuation
      // round / cron resumes it immediately (a clean stop -- this drain is ending).
      const doneNow = await scoredGrantIds(db, candidate.id);
      const stillRemaining = pool.some((g) => !doneNow.has(g.id));
      if (!stillRemaining) {
        await db
          .from("clients")
          .update({ initial_match_status: "complete", match_locked_at: null })
          .eq("id", candidate.id);
        completed.push(candidate.id);
      } else {
        // Budget must be spent (scorePairsWithinBudget only returns early on the
        // deadline). Release the lease so the immediate next resume can reclaim, then
        // stop so we don't spin re-picking the same client.
        await db.from("clients").update({ match_locked_at: null }).eq("id", candidate.id);
        budgetExhausted = true;
        break;
      }
    } catch (err) {
      // A hard failure (attempt lookup / claim) -> mark 'error', release the lease,
      // move on. Per-pair failures never reach here (scoreGrantClientPair swallows them).
      const detail = String(err instanceof Error ? err.message : err).slice(0, 300);
      console.error(`Client match drain error for ${candidate.id}:`, err);
      await db
        .from("clients")
        .update({ initial_match_status: "error", match_locked_at: null })
        .eq("id", candidate.id);
      errored.push({ id: candidate.id, error: detail });
    }
  }

  const wallMs = Date.now() - startedAt;
  console.log(
    `[client-match-timing] scoredPairs=${totalScored} abandonedAtCutoff=${totalAbandoned} ` +
      `peakInFlight=${peakInFlight}/${CONCURRENCY} wallMs=${wallMs} budgetMs=${budgetMs} ` +
      `budgetExhausted=${budgetExhausted} advancedClients=${advanced.length} completedClients=${completed.length}`,
  );

  return { advanced, completed, errored, budgetExhausted, queueEmpty };
}
