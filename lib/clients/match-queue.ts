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

// Hard deadline for a single invocation, well under the 300s function cap. Workers
// stop claiming at this wall-clock and the invocation returns at it (see
// scorePairsWithinBudget's race), so a pair stuck in 429 backoff can't drag it to the
// 300s kill. In-flight pairs abandoned at the cutoff are NOT re-scored -- each holds a
// per-pair reservation lock (below), so the next round skips them; the cron/resume
// finishes whatever didn't fit. (A grace window that tried to drain the wave in-band
// was removed: the logs showed pairs run ~60-90s under backoff, far past any grace
// that fits under the ~100s cap, so it never drained -- reservation is the real fix.)
const DEFAULT_BUDGET_MS = 210_000;

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

// Per-pair reservation lock TTL (migration 0050, match_pair_locks). A worker CLAIMS
// (client_id, grant_id) before its LLM call and RENEWS the lock every
// RENEW_INTERVAL_MS while scoring; another worker/round skips a pair whose lock is
// younger than this. That's what stops the window-boundary re-score: an in-flight
// pair abandoned when a round returns keeps a live lock, so the next round can't
// re-score it. The TTL is deliberately NOT sized to "worst-case pair time" -- the
// Anthropic SDK has no hard request timeout, so a backed-off pair can run for minutes
// with no clean upper bound. Renewal makes that irrelevant: a slow-but-alive pair
// stays fresh and is never stolen; only a worker that STOPS renewing (frozen/killed)
// lets its lock age past the TTL and be reclaimed (so the pool still completes). So
// the TTL only has to clear the renewal interval -- 90s is 3.6x the 25s renew.
const PAIR_LOCK_TTL_MS = 90_000;

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

// Atomically CLAIM the per-pair reservation for (client, grant) before its LLM call.
// Returns true if we own it (go score), false if a live worker/round holds a fresh
// lock (skip -- this is what prevents the boundary re-score). Two atomic steps:
//   1. insert the lock; if the row didn't already exist, we claimed it.
//   2. on PK conflict, take over ONLY if the existing lock is stale (>TTL) -- a
//      conditional UPDATE, so a fresh lock held by a live worker is never stolen.
// Any unexpected (non-conflict) error -> false: safer to skip and let a later round
// retry than to risk a double LLM call. A skipped-on-error pair set no lock, so it's
// immediately re-claimable next round (no permanent stall).
async function claimPair(db: DB, clientId: string, grantId: string): Promise<boolean> {
  const nowIso = new Date().toISOString();
  const { error } = await db
    .from("match_pair_locks")
    .insert({ client_id: clientId, grant_id: grantId, locked_at: nowIso });
  if (!error) return true; // no prior lock -> claimed
  if (error.code !== "23505") {
    // NOT a PK conflict -> a real DB error, distinct from a normal "lock held" skip
    // (which returns false SILENTLY below). Log LOUD + greppable: if migration 0050
    // wasn't applied this fires for EVERY pair -> scoredPairs=0, which would otherwise
    // read as a mysterious no-op instead of an obvious missing migration. Fail closed
    // (skip) regardless -- never risk a double LLM call on an unknown error.
    const detail =
      error.code === "42P01"
        ? "match_pair_locks table MISSING -- apply migration 0050"
        : "unexpected DB error";
    console.error(`[claimPair] ${detail} (code=${error.code ?? "?"}): ${error.message}`);
    return false;
  }
  const staleIso = new Date(Date.now() - PAIR_LOCK_TTL_MS).toISOString();
  const { data } = await db
    .from("match_pair_locks")
    .update({ locked_at: nowIso })
    .eq("client_id", clientId)
    .eq("grant_id", grantId)
    .lt("locked_at", staleIso)
    .select("grant_id");
  return !!(data && data.length); // took over a stale lock, else a live worker owns it
}

// Renew our reservation every RENEW_INTERVAL_MS while a pair is scoring, so a
// slow-but-alive pair (60-90s+, unbounded under backoff) is never seen as stale and
// stolen. Returns a stop fn (cleared when the pair finishes/errors). Fire-and-forget
// updates -- a missed renewal only risks the lock aging early, which is safe.
function startPairLockRenewal(db: DB, clientId: string, grantId: string): () => void {
  const iv = setInterval(() => {
    void db
      .from("match_pair_locks")
      .update({ locked_at: new Date().toISOString() })
      .eq("client_id", clientId)
      .eq("grant_id", grantId);
  }, RENEW_INTERVAL_MS);
  return () => clearInterval(iv);
}

// Score (grant, client) pairs with a bounded rolling pool. Two stops:
//   1. Each worker refuses to CLAIM a new pair once deadlineMs passes.
//   2. The batch is RACED against deadlineMs, so a pair stuck in 429 backoff can't
//      hold the invocation past budget (the original 300s-overrun guard).
// Correctness against the window boundary comes from the PER-PAIR RESERVATION, not
// timing: each worker claimPair()s (client, grant) BEFORE its LLM call and renews the
// lock while scoring. A pair still in flight when this returns keeps a live lock, so
// the next round's claimPair skips it -- it is never re-scored (which is what caused
// the duplicate attempts + double LLM spend). A pair whose worker is frozen/killed
// stops renewing, its lock ages past PAIR_LOCK_TTL_MS, and a later round reclaims it,
// so the pool still completes. Returns pairs finished, peak concurrency (peak ~=
// CONCURRENCY confirms real parallelism vs backoff serialization), and how many were
// still in flight at return (`inFlightAtCutoff`) -- now HARMLESS (lock-protected),
// kept as a backoff-pressure signal, not a dup indicator.
async function scorePairsWithinBudget(
  db: DB,
  client: Client,
  pairs: Grant[],
  deadlineMs: number,
): Promise<{ completed: number; peakInFlight: number; inFlightAtCutoff: number }> {
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
      const grantId = pairs[i].id;
      // Reserve the pair before its (paid) LLM call. If a live worker/round already
      // holds it (fresh lock), skip -- this is what stops the next round re-scoring a
      // pair still in flight from this one.
      if (!(await claimPair(db, client.id, grantId))) continue;
      inFlight++;
      if (inFlight > peakInFlight) peakInFlight = inFlight;
      const stopRenew = startPairLockRenewal(db, client.id, grantId);
      try {
        await scoreGrantClientPair(pairs[i], client, db);
        completed++;
      } finally {
        inFlight--;
        // Stop renewing, but do NOT delete the lock here. A finished pair is already
        // excluded via its match_attempts row; deleting the lock would reopen the
        // dup race (a concurrent round computed `remaining` while this pair was still
        // unattempted, then finds no lock and re-scores it). The lock is swept when
        // the client completes, or reclaimed via TTL if a worker died pre-commit.
        stopRenew();
      }
    }
  };
  const workers = Promise.all(
    Array.from({ length: Math.min(CONCURRENCY, pairs.length) }, worker),
  );
  // Hard stop: resolve at the deadline even if in-flight pairs are still running, so a
  // backoff straggler can't push the invocation to the 300s kill. Abandoning the wave
  // here is now SAFE -- each in-flight pair holds a live reservation lock, so the next
  // round skips (never re-scores) it. Clear the timer if the workers win the race so a
  // fast run doesn't keep the billed function alive until the deadline fires.
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, Math.max(0, deadlineMs - Date.now()));
  });
  try {
    await Promise.race([workers, deadline]);
  } finally {
    if (timer) clearTimeout(timer);
  }
  // In-flight at return (0 if the workers won the race). Lock-protected -- NOT re-scored
  // -- so this is a backoff-pressure signal (how many pairs are mid-flight at the cutoff),
  // not a dup count. Dups are verified directly (match_attempts total vs distinct).
  const inFlightAtCutoff = inFlight;
  return { completed, peakInFlight, inFlightAtCutoff };
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
  // Pairs still in flight at a window's cutoff, summed across windows. Lock-protected
  // (not re-scored) -- a backoff-pressure signal, not a dup count.
  let totalInFlightAtCutoff = 0;

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
    const { data: candidate, error: candidateErr } = await db
      .from("clients")
      .select("*")
      .in("initial_match_status", ["queued", "running"])
      .or(leaseClaimableFilter())
      .order("created_at", { ascending: true })
      .limit(1)
      .maybeSingle<Client>();
    // A query ERROR is NOT an empty queue -- do not mislabel it as queueEmpty (the
    // silent-stall shape from incident 2026-07-21). Throw a loud, greppable message
    // (with the PostgREST code, like claimPair) so /api/cron/client-match visibly 500s
    // and shows in logs, mirroring the grant drain.
    if (candidateErr) {
      throw new Error(
        `[drainClientMatchQueue] candidate query failed (code=${candidateErr.code ?? "?"}): ${candidateErr.message}`,
      );
    }
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
        // Nothing left (pool empty, or a prior invocation finished it) -> land it,
        // release the lease, and clear any orphan pair locks for this client.
        await db
          .from("clients")
          .update({ initial_match_status: "complete", match_locked_at: null })
          .eq("id", candidate.id);
        await db.from("match_pair_locks").delete().eq("client_id", candidate.id);
        completed.push(candidate.id);
        continue;
      }

      const { completed: pairsDone, peakInFlight: peak, inFlightAtCutoff } =
        await scorePairsWithinBudget(db, candidate, remaining, deadlineMs);
      totalScored += pairsDone;
      totalInFlightAtCutoff += inFlightAtCutoff;
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
        await db.from("match_pair_locks").delete().eq("client_id", candidate.id);
        completed.push(candidate.id);
      } else {
        // Work remains, but this round is done with it: either the budget is spent, or
        // every still-unattempted pair is currently locked by an in-flight worker (from
        // this round's abandoned wave), so there's nothing left to claim right now.
        // Release the lease so the next continuation round / cron reclaims, and stop so
        // we don't spin re-picking the same client within this invocation. The client
        // loop re-POSTs; those locked pairs commit (or their locks expire) and the next
        // round finishes them.
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
    `[client-match-timing] scoredPairs=${totalScored} inFlightAtCutoff=${totalInFlightAtCutoff} ` +
      `peakInFlight=${peakInFlight}/${CONCURRENCY} wallMs=${wallMs} budgetMs=${budgetMs} ` +
      `budgetExhausted=${budgetExhausted} advancedClients=${advanced.length} completedClients=${completed.length}`,
  );

  return { advanced, completed, errored, budgetExhausted, queueEmpty };
}
