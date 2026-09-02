// Auto-inline IntellEngine QA — the queue, the poller, and the drain (Step 3, PR 1).
//
// WHAT THIS DOES. Makes the on-demand QA pass AUTOMATIC: a POLLER finds every surfaced (grant, client)
// pending card with no verdict yet and enqueues it; a DRAIN runs runIntelReview on each and writes the
// verdict to card_intel_reviews. Both run from one cron (/api/cron/intel-drain), gated behind
// AUTO_INTEL_ENABLED (default OFF → nothing runs, byte-identical to today).
//
// TWO INVARIANTS CARRIED FROM THE ON-DEMAND PASS, unchanged:
//   PROPOSAL-ONLY: this writes card_intel_reviews ONLY (via runIntelReview's output), never
//     review_cards.fit_score / seat / decision / suppressed. Auto-QA can NEVER remove or re-score a
//     card. It also never calls scoreGrantClientPair.
//   H1 (surface, then attach): a card is NEVER held out of the report waiting for QA. It surfaces
//     immediately; the verdict attaches when the drain gets to it. Hiding a match is exactly what this
//     must not do, so the queue is a pure side-channel — the report query does not depend on it.
//
// ZERO protected-file touch: enqueue is a poller (this module + the cron), not a hook in pipeline.ts.
//
// COST IS BOUNDED. Each run logs an estimate to intel_auto_run_log; the drain sums today's spend and
// stops once INTEL_AUTO_DAILY_CAP_USD is reached, deferring the rest to tomorrow rather than running
// unbounded. Concurrency- and deadline-bounded per invocation (each QA is ~2-5 min; a few run in
// parallel within the 300s cron budget).
//
// PURE-TESTABLE: the model call (runReview) and the clock (now) are injected, so eligibility, the cap,
// the status transitions, and the proposal-only property are unit-tested with a fake DB and no network.

import { randomUUID } from "node:crypto";
import { createServiceClient } from "@/lib/supabase/server";
import { runIntelReview, type IntelReview, type IntelCard } from "@/lib/grants/intel-review";
import type { Grant, Client, FactorScores } from "@/types/database";

type DB = ReturnType<typeof createServiceClient>;

// ── Flag + config (env-overridable; defaults are conservative) ────────────────────────────────────
export function autoIntelEnabled(): boolean {
  return process.env.AUTO_INTEL_ENABLED === "true";
}

// ── Apply-the-gate (Step 3, PR B) ──────────────────────────────────────────────────────────────────
// A SECOND flag, independent of AUTO_INTEL_ENABLED: when ON, the drain PROJECTS the QA verdict onto the
// card's qa_* OVERRIDE columns (0088) so the displayed score/factors become QA's. It never touches the
// engine's own fit_score / factor_scores / decision / suppressed — the read layer (PR C) coalesces
// qa_fit_score ?? fit_score. Default OFF is byte-identical: no qa_* column is written, so the coalesce is
// inert and the card is exactly today's. NEVER-HIDE is structural (review_cards has no suppress column;
// a demote only lowers the OVERRIDE score, the row still surfaces).
export function autoIntelApplyEnabled(): boolean {
  return process.env.AUTO_INTEL_APPLY === "true";
}

// BROAD apply (Step 3, the widening): a THIRD flag, layered under AUTO_INTEL_APPLY. When OFF, apply is
// gated to APPLY_ELIGIBLE_CFDAS (the narrow, per-program allowlist below). When ON, the CFDA allowlist STOPS
// being the trust boundary — a grounded demote AUTO-APPLIES regardless of CFDA, and the gate becomes
// grounding + a clean adversarial refute:
//   - grounded demote + refute_survived === true  → AUTO-APPLY  (the refute-clean set).
//   - grounded demote + refute_survived false/null → STAFF-FLAG, never auto-applied — the verdict stays
//     durable in card_intel_reviews (staff-visible) and a human applies it via the manual Re-run route.
// Grounding is already guaranteed upstream: a "demote" verdict only survives finalizeIntel if it FETCHED a
// relevant .gov page (hasSuccessfulFetch), so the added gate here is refute-clean alone. The refute split is
// the real backstop beyond the eval sample — auto only ever touches a demote that survived an adversarial
// re-read. AUTO_INTEL_APPLY_BROAD OFF is byte-identical to the narrow allowlist path (the ternary in the
// drain gate collapses to cardCfdaApplyEligible, and buildQaPatch's requireRefuteClean stays false).
export function autoIntelApplyBroadEnabled(): boolean {
  return process.env.AUTO_INTEL_APPLY_BROAD === "true";
}

// The per-program allowlist. Under NARROW apply (AUTO_INTEL_APPLY_BROAD OFF) it is the apply trust boundary:
// apply-mode acts ONLY on the CFDAs listed here; every OTHER program stays PROPOSAL-ONLY. Under BROAD apply
// it is NO LONGER the trust boundary (grounding + refute-clean is) — it is retained as (a) the narrow-mode
// gate, the instant fallback if broad is flipped off, and (b) a scrutiny / pre-tag HINT: these are the
// programs whose allocation reality the NOFO understates, seeded in allocation-sources so QA fetches the
// authoritative page. Members (proven end-to-end before they were added):
//   - 16.738 JAG-Local — eval run #8: grounded demote→2, 3/3, affirms untouched.
//   - 16.575 VOCA Victim Assistance — seeded (OVC formula-grants page states the state-administering-agency /
//     local-subgrantee rule on the landing page itself) + eval cases 4 (grounded demote of a subgrant-only
//     nonprofit) and 7 (state administering agency AFFIRMED, the no-false-demote guard).
export const APPLY_ELIGIBLE_CFDAS = new Set<string>(["16.738", "16.575"]);

// Strip a trailing letter suffix (e.g. "16.738A" → "16.738"); mirrors allocation-sources / formula-programs.
function normalizeCfda(raw: string): string {
  return raw.trim().replace(/[A-Za-z]$/, "");
}

// Is this grant on the apply allowlist? A single assistance-listing match is enough. Empty/unknown → false
// (fail closed: an unrecognized program stays proposal-only).
export function cardCfdaApplyEligible(grant: Pick<Grant, "assistance_listings">): boolean {
  for (const a of grant.assistance_listings ?? []) {
    const num = a?.number ? normalizeCfda(a.number) : "";
    if (num && APPLY_ELIGIBLE_CFDAS.has(num)) return true;
  }
  return false;
}

// The card fields the apply-write reads: the engine's own score (staleness snapshot + demote floor) and its
// real per-factor scores (the merge base for qa_factor_scores).
export interface ApplyCard {
  id: string;
  fit_score: number | null;
  factor_scores: FactorScores | null;
}

// The qa_* override patch written to review_cards. EVERY key is qa_-prefixed — this is the structural
// guarantee the drain never writes an engine column (locked by the "writes ONLY qa_* columns" test).
export interface QaPatch {
  qa_fit_score?: number | null;
  qa_factor_scores?: FactorScores | null;
  qa_sources?: string[] | null;
  // The client-safe verdict narrative (the go/no-go reasoning body). Rides EVERY resolved verdict whose
  // narrative passed the framing guard at generation time — a demote, an affirm, or a flag — carried verbatim
  // from finalizeIntel (null for unverified / a guarded-away leak). The score column still clears on a
  // non-demote (qa_fit_score: null); only the reasoning paragraph is preserved, freshness-gated by the
  // snapshot below, so a reversal shows the NEW verdict's reasoning, never a stale demote paragraph.
  qa_narrative?: string | null;
  qa_status: "applied" | "unverified" | "none";
  qa_engine_fit_score?: number | null;
  qa_applied_at: string;
  // NULL = the automatic pass; a staff user id = a human on-demand "Re-run" applied it (audit; mirrors
  // card_intel_reviews.created_by). The drain passes null; the manual route passes the acting staff id.
  qa_reviewed_by: string | null;
}

// Build the qa_* projection for a verdict. PURE + exported so the projection (merge, floor, status, the
// qa_*-only invariant) is unit-tested with no DB. A DEMOTE applies (rewrites the displayed score + merged
// factors + grounded sources); every OTHER verdict returns a CLEARING patch that nulls the score columns so
// the read-layer coalesce falls back to the engine score — differing only in qa_status: 'unverified' (QA
// couldn't verify) vs 'none' (affirm agrees / flag is a concern with no score change). The clear is
// LOAD-BEARING, not cosmetic: a card can be applied-demoted and then a re-run REVERSES to affirm/flag/
// unverified — with the engine score unchanged the staleness guard still honors the old override, so
// without an explicit clear the stale demoted score would keep displaying under a verdict that no longer
// demotes. On a never-applied card the clear is a harmless no-op (the columns were already null).
export function buildQaPatch(
  card: ApplyCard,
  review: IntelReview,
  nowIso: string,
  reviewedBy: string | null = null,
  // BROAD apply only (the auto drain passes autoIntelApplyBroadEnabled()): when true, a grounded demote
  // AUTO-APPLIES only if the adversarial refute confirmed it (refute_survived === true). A grounded demote
  // whose refute was genuinely refuted (false) or couldn't complete (null) falls through to the clearing
  // patch = STAFF-FLAG: no score change, the card shows the engine score, and the demote verdict stays
  // durable in card_intel_reviews for a human to apply via Re-run. Defaults FALSE so the narrow drain and
  // the manual Re-run route (a human is the fan-out gate there) are byte-identical — grounding alone gates.
  requireRefuteClean = false,
): QaPatch {
  const demoteApplies =
    review.verdict === "demote" &&
    review.qa_fit_score != null &&
    (!requireRefuteClean || review.refute_survived === true);
  if (demoteApplies) {
    // Merge QA's CHANGED factor(s) onto the engine's REAL factors — never store the model's fabricated five.
    const mergedFactors: FactorScores | null = review.qa_factor_scores
      ? ({ ...(card.factor_scores ?? {}), ...review.qa_factor_scores } as FactorScores)
      : card.factor_scores;
    // The grounded .gov pages QA actually fetched — client-safe URLs, deduped, shown on the card.
    const sources = Array.from(
      new Set(review.fetched.filter((f) => f.ok).map((f) => f.finalUrl ?? f.url).filter((u): u is string => !!u)),
    );
    return {
      qa_fit_score: review.qa_fit_score,
      qa_factor_scores: mergedFactors,
      qa_sources: sources,
      // Already guarded + demote-gated in finalizeIntel (null when the flag is off, the model omitted it, or
      // narrativeGuard nulled a leaky one) → the display falls back to the engine paragraph. Verbatim here.
      qa_narrative: review.narrative,
      qa_status: "applied",
      qa_engine_fit_score: card.fit_score, // snapshot: the read-layer ignores the override once fit_score moves
      qa_applied_at: nowIso,
      qa_reviewed_by: reviewedBy,
    };
  }
  // Every non-demote verdict CLEARS the SCORE override (qa_fit_score: null) — the load-bearing reversal
  // safety: the read-layer coalesce is `qa_fit_score ?? fit_score`, so a null score column ALWAYS shows the
  // engine score, independent of the freshness snapshot below. So a demote → affirm re-run correctly drops
  // the demoted number even though we now keep a snapshot.
  //
  // The verdict NARRATIVE (the go/no-go reasoning body) rides an affirm/flag's OWN grounded reasoning here —
  // BUT NEVER a DEMOTE's. A demote that reaches this clearing branch is one that did NOT apply: under
  // broad-apply a refute-UNCLEAN demote is held for staff (score untouched), and CLAUDE.md's invariant is
  // that such a card stays INDISTINGUISHABLE from one QA never touched. Carrying the demote's disqualifying
  // "no-go" paragraph here would render it under the ORIGINAL, un-demoted engine score + verdict lead — the
  // exact contradiction that invariant forbids. So a demote clears its narrative too (null); only a
  // non-demote (affirm/flag) carries its reasoning, with the freshness snapshot to gate it (dropped on an
  // engine re-score). The score coalesces to the engine number regardless; only a non-demote's prose rides.
  const carryNarrative = review.verdict !== "demote" ? review.narrative : null;
  return {
    qa_fit_score: null,
    qa_factor_scores: null,
    qa_sources: null,
    qa_narrative: carryNarrative,
    qa_status: review.verdict === "unverified" ? "unverified" : "none",
    qa_engine_fit_score: carryNarrative ? card.fit_score : null,
    qa_applied_at: nowIso,
    qa_reviewed_by: reviewedBy,
  };
}

const numEnv = (v: string | undefined, d: number): number => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : d;
};
const intEnv = (v: string | undefined, d: number): number => Math.floor(numEnv(v, d));

// A single QA run is Opus + a few web_searches + fetched-page tokens — roughly this. A flat estimate is
// enough for the ceiling (a safety cap, not billing). Real per-token accounting is a later refinement.
export const INTEL_EST_COST_PER_CARD_USD = numEnv(process.env.INTEL_EST_COST_PER_CARD_USD, 0.3);
// Hard daily ceiling: once today's summed estimate reaches this, the drain stops and defers to tomorrow.
export const INTEL_AUTO_DAILY_CAP_USD = numEnv(process.env.INTEL_AUTO_DAILY_CAP_USD, 30);
// How many eligible cards the poller enqueues per invocation, and the page size it scans in.
export const INTEL_POLL_LIMIT = intEnv(process.env.INTEL_POLL_LIMIT, 50);
// The poller pages past already-verdicted / blocked cards to reach eligible ones behind them; this bounds
// how far it scans per invocation (INTEL_POLL_LIMIT × this many pages) so a huge blocked prefix can't make
// one poll run unbounded. A prefix larger than the whole scan is the systemic-failure case a later
// watchdog (PR 2) covers; here we just never jam on a realistic backlog.
export const INTEL_POLL_MAX_PAGES = intEnv(process.env.INTEL_POLL_MAX_PAGES, 20);
// QA passes run in parallel per invocation (I/O-bound on the model); each still gets its own budget.
export const INTEL_DRAIN_CONCURRENCY = intEnv(process.env.INTEL_DRAIN_CONCURRENCY, 3);
// Retry a failed job up to this many attempts, then park it as 'error' (never silently dropped).
export const INTEL_MAX_ATTEMPTS = intEnv(process.env.INTEL_MAX_ATTEMPTS, 3);
// A 'processing' row older than this is treated as a crashed drain and reclaimed to 'queued'.
export const INTEL_STALE_PROCESSING_MS = intEnv(process.env.INTEL_STALE_PROCESSING_MS, 20 * 60 * 1000);

// ── Types ─────────────────────────────────────────────────────────────────────────────────────────
interface QueueRow {
  id: string;
  grant_id: string;
  client_id: string;
  status: string;
  attempts: number;
}

export interface DrainOptions {
  // Injected for tests; default is the real Opus + web pass.
  runReview?: (card: IntelCard, grant: Grant, client: Client) => Promise<IntelReview>;
  now?: () => number;
  concurrency?: number;
  estCostUsd?: number;
  dailyCapUsd?: number;
}

export interface DrainResult {
  enqueued: number;
  processed: number;
  done: number;
  skipped: number;
  errored: number;
  reclaimed: number;
  capReached: boolean;
  spentTodayUsd: number;
}

const pairKey = (g: string, c: string) => `${g}:${c}`;

function startOfUtcDayIso(nowMs: number): string {
  const d = new Date(nowMs);
  d.setUTCHours(0, 0, 0, 0);
  return d.toISOString();
}

// ── The poller: enqueue every eligible surfaced pair that has no verdict yet ────────────────────────
// Eligible = a PENDING, unreleased, CLIENT (not prospect) card with a real (grant, client) pair, that
// (a) has no card_intel_reviews verdict, and (b) has no BLOCKING queue row (queued/processing/error).
// A prior 'done' queue row IS re-queued by the upsert — which is how a card re-scored after a
// rematch-clear (#436 cleared its verdict) gets re-QA'd. A prior 'error' row is NOT re-queued: parking as
// 'error' after INTEL_MAX_ATTEMPTS is a terminal backstop (surfaced for a human, never silently retried).
// An errored card wrote no verdict, so the (a) check can't catch it — if the poller re-queued it too, a
// persistently-failing card would be resurrected every cycle and burn the daily cost cap forever,
// defeating the very backstop. Resetting an errored pair for another attempt is a deliberate human /
// PR-2-watchdog action, not an automatic poll. (A card whose verdict is stale because the drain re-scored
// it in place still HAS a verdict, so it is not re-picked here — that staleness refresh is deliberately a
// PR-2 lifecycle refinement, not PR 1.)
//
// PAGE PAST blocked cards, don't post-filter a single fixed window (#442 review finding). Oldest-first is
// FIFO — matches the drain's enqueued_at-ASC claim order — but the oldest pending cards are DOMINATED by
// ones already blocked from re-QA: a QA'd card stays decision='pending' until staff act, so its verdict
// filters it out, and terminally error-parked cards never leave 'pending' at all. Fetching one oldest-N
// window and filtering it in JS would then return an EMPTY eligible set for cycle after cycle while newer,
// genuinely-eligible cards starve behind that wall of already-done rows. So instead we scan oldest-first
// in pages, skipping blocked/verdicted cards, until we've collected `limit` eligible pairs or exhausted a
// bounded scan (INTEL_POLL_LIMIT × INTEL_POLL_MAX_PAGES cards) — the window always advances past the wall.
export async function pollAndEnqueue(db: DB, opts: { now?: () => number; limit?: number } = {}): Promise<number> {
  const now = opts.now ?? (() => Date.now());
  const limit = opts.limit ?? INTEL_POLL_LIMIT;
  const pageSize = Math.max(1, limit);

  // Blocking (grant,client) pairs — any live/terminal queue row. Fetched once; queued/processing are
  // in flight, 'error' is terminally parked. Only a 'done' row is re-queueable (its verdict cleared), which
  // the upsert below handles by NOT appearing here.
  const { data: blocking } = await db
    .from("intel_review_queue")
    .select("grant_id, client_id")
    .in("status", ["queued", "processing", "error"])
    .returns<{ grant_id: string; client_id: string }[]>();
  const blocked = new Set((blocking ?? []).map((q) => pairKey(q.grant_id, q.client_id)));

  // Paused clients (match_active=false, migration 0091 — Lever A) drop out of auto-QA the same
  // way the forward matcher skips them, so a not-yet-onboarded client's card backlog never spends
  // QA budget. Fetched once (the set is tiny); flag-independent — this bites whenever the poller
  // runs, regardless of the APPLY flags. Reversible: un-pausing lets the client's cards flow again.
  const { data: pausedRows } = await db
    .from("clients")
    .select("id")
    .eq("match_active", false)
    .returns<{ id: string }[]>();
  const pausedClients = new Set((pausedRows ?? []).map((r) => r.id));

  const eligible: { id: string; grant_id: string; client_id: string }[] = [];
  for (let page = 0; page < INTEL_POLL_MAX_PAGES && eligible.length < limit; page++) {
    const { data: cards } = await db
      .from("review_cards")
      .select("id, grant_id, client_id")
      .eq("decision", "pending")
      .is("sme_released_at", null)
      .eq("card_type", "client")
      .not("client_id", "is", null)
      .not("grant_id", "is", null)
      .order("created_at", { ascending: true })
      .range(page * pageSize, page * pageSize + pageSize - 1)
      .returns<{ id: string; grant_id: string; client_id: string }[]>();
    if (!cards || cards.length === 0) break;

    // Verdicts are scoped to THIS page's cards (cheap), unlike the blocked-pairs set which spans the queue.
    const { data: verdicts } = await db
      .from("card_intel_reviews")
      .select("review_card_id")
      .in("review_card_id", cards.map((c) => c.id))
      .returns<{ review_card_id: string }[]>();
    const qad = new Set((verdicts ?? []).map((v) => v.review_card_id));

    for (const c of cards) {
      if (
        !qad.has(c.id) &&
        !blocked.has(pairKey(c.grant_id, c.client_id)) &&
        !pausedClients.has(c.client_id)
      ) {
        eligible.push({ id: c.id, grant_id: c.grant_id, client_id: c.client_id });
        if (eligible.length >= limit) break;
      }
    }
    if (cards.length < pageSize) break; // reached the end of the pending backlog
  }
  if (eligible.length === 0) return 0;

  // Dedup by (grant, client): a pair can have more than one pending card, and offset pages can overlap if
  // rows shift mid-poll — Postgres rejects an upsert whose payload hits the same conflict key twice
  // ("ON CONFLICT DO UPDATE command cannot affect row a second time").
  const seenPairs = new Set<string>();
  const toEnqueue = eligible.filter((c) => {
    const k = pairKey(c.grant_id, c.client_id);
    if (seenPairs.has(k)) return false;
    seenPairs.add(k);
    return true;
  });

  const nowIso = new Date(now()).toISOString();
  const rows = toEnqueue.map((c) => ({
    grant_id: c.grant_id,
    client_id: c.client_id,
    status: "queued",
    attempts: 0,
    error_detail: null,
    enqueued_at: nowIso,
    started_at: null,
    finished_at: null,
    updated_at: nowIso,
  }));
  // onConflict (grant, client): resets a prior 'done' row back to queued (the re-QA-after-clear path).
  // Never hits a queued/processing/error row — all filtered out above — so an in-flight job is undisturbed
  // and a terminally-parked 'error' row stays parked.
  const { error } = await db.from("intel_review_queue").upsert(rows, { onConflict: "grant_id,client_id" });
  if (error) {
    console.error("[auto-intel] enqueue failed", error);
    return 0;
  }
  return toEnqueue.length;
}

// ── The drain: run QA on queued jobs, bounded by the daily cost cap + concurrency ───────────────────
export async function drainIntelQueue(db: DB, opts: DrainOptions = {}): Promise<Omit<DrainResult, "enqueued">> {
  const now = opts.now ?? (() => Date.now());
  const runReview = opts.runReview ?? defaultRunReview;
  const concurrency = opts.concurrency ?? INTEL_DRAIN_CONCURRENCY;
  const estCost = opts.estCostUsd ?? INTEL_EST_COST_PER_CARD_USD;
  const dailyCap = opts.dailyCapUsd ?? INTEL_AUTO_DAILY_CAP_USD;

  const result = { processed: 0, done: 0, skipped: 0, errored: 0, reclaimed: 0, capReached: false, spentTodayUsd: 0 };

  // 1. Reclaim jobs stuck in 'processing' so they aren't lost — but honor the attempt cap here too.
  // A job killed OUT of process (function timeout at maxDuration=300s mid-runReview, OOM, crash) never
  // reaches processOne's catch, so its cap check never runs; it just sits 'processing' with attempts
  // already incremented at claim time. The reclaim is that path's ONLY backstop. Without a cap check it
  // would requeue such a job forever on the ~20-min stale cycle — a chronically-timing-out pair retrying
  // indefinitely, burning cost against the daily cap and defeating "retries to a cap then parks as error".
  // So: a stale row that has already used its attempts parks as 'error' (surfaced, never silently dropped);
  // the rest requeue. Park FIRST so the requeue (still status='processing') can't pick the parked ones up.
  const staleBeforeIso = new Date(now() - INTEL_STALE_PROCESSING_MS).toISOString();
  const nowIso1 = new Date(now()).toISOString();
  const { data: parkedStale } = await db
    .from("intel_review_queue")
    .update({ status: "error", finished_at: nowIso1, updated_at: nowIso1, error_detail: "stale processing: killed out-of-process, attempt cap reached" })
    .eq("status", "processing")
    .lt("started_at", staleBeforeIso)
    .gte("attempts", INTEL_MAX_ATTEMPTS)
    .select("id")
    .returns<{ id: string }[]>();
  result.errored += parkedStale?.length ?? 0;
  const { data: reclaimed } = await db
    .from("intel_review_queue")
    .update({ status: "queued", updated_at: nowIso1 })
    .eq("status", "processing")
    .lt("started_at", staleBeforeIso)
    .select("id")
    .returns<{ id: string }[]>();
  result.reclaimed = reclaimed?.length ?? 0;

  // 2. Daily cost ceiling. Sum today's estimated spend; stop if we're already at/over the cap.
  const spent = await dailySpentUsd(db, now());
  result.spentTodayUsd = spent;
  const budgetLeft = dailyCap - spent;
  if (budgetLeft < estCost) {
    result.capReached = true;
    return result;
  }
  // How many cards today's remaining budget affords, capped by this invocation's concurrency.
  const affordable = Math.floor(budgetLeft / estCost);
  const batchSize = Math.max(0, Math.min(concurrency, affordable));
  if (batchSize === 0) {
    result.capReached = true;
    return result;
  }

  // 3. Claim a batch of queued jobs (oldest first) → mark processing.
  const { data: queued } = await db
    .from("intel_review_queue")
    .select("id, grant_id, client_id, status, attempts")
    .eq("status", "queued")
    .order("enqueued_at", { ascending: true })
    .limit(batchSize)
    .returns<QueueRow[]>();
  if (!queued || queued.length === 0) return result;

  const nowIso = new Date(now()).toISOString();
  await Promise.all(
    queued.map((row) =>
      db.from("intel_review_queue").update({ status: "processing", started_at: nowIso, attempts: row.attempts + 1, updated_at: nowIso }).eq("id", row.id),
    ),
  );

  // 4. Run them concurrently (I/O-bound). Each processOne owns its own status transition + cost log.
  const outcomes = await Promise.all(queued.map((row) => processOne(db, row, { now, runReview, estCost })));
  for (const o of outcomes) {
    result.processed += 1;
    if (o === "done") result.done += 1;
    else if (o === "skipped") result.skipped += 1;
    else result.errored += 1;
  }
  return result;
}

// Sum today's (UTC) estimated auto-QA spend from the append-only run log.
async function dailySpentUsd(db: DB, nowMs: number): Promise<number> {
  const { data } = await db
    .from("intel_auto_run_log")
    .select("cost_estimate_usd")
    .gte("ran_at", startOfUtcDayIso(nowMs))
    .returns<{ cost_estimate_usd: number }[]>();
  return (data ?? []).reduce((sum, r) => sum + (Number(r.cost_estimate_usd) || 0), 0);
}

// Run QA for one claimed job. Resolves the CURRENT pending card for the pair (not a stored id), runs the
// pass, writes the verdict, logs the cost. Returns the transition it applied.
async function processOne(
  db: DB,
  row: QueueRow,
  deps: { now: () => number; runReview: (c: IntelCard, g: Grant, cl: Client) => Promise<IntelReview>; estCost: number },
): Promise<"done" | "skipped" | "error"> {
  const { now, runReview, estCost } = deps;
  const finish = (patch: Record<string, unknown>) =>
    db.from("intel_review_queue").update({ ...patch, updated_at: new Date(now()).toISOString() }).eq("id", row.id);

  // The claim step already wrote attempts = row.attempts + 1 to the DB, but the SELECT'd `row` is a
  // detached snapshot from BEFORE that increment (supabase does not mutate it), so THIS run is attempt
  // number (row.attempts + 1). Judge the cap against that post-increment count — checking the stale
  // row.attempts would run one extra Opus+web attempt (and cost-log entry) past INTEL_MAX_ATTEMPTS.
  const attemptsSoFar = row.attempts + 1;

  // The current pending, unreleased, client card for this pair. If it's gone (decided / released /
  // removed since enqueue), there is nothing to QA — mark done, no cost. (H1 never held it.)
  const { data: card } = await db
    .from("review_cards")
    .select("id, fit_score, factor_scores, proposed_role, recommended_prime, why_this_org, before_you_approve, reasoning_context")
    .eq("grant_id", row.grant_id)
    .eq("client_id", row.client_id)
    .eq("decision", "pending")
    .is("sme_released_at", null)
    .eq("card_type", "client")
    .limit(1)
    .maybeSingle<IntelCard & ApplyCard>();
  if (!card) {
    await finish({ status: "done", finished_at: new Date(now()).toISOString(), error_detail: "card no longer pending" });
    return "skipped";
  }

  // A verdict can appear between enqueue and now — most likely a staffer ran the on-demand Intel pass
  // (POST /api/review/[id]/intel, created_by = their user id) while this auto job waited. The auto pass
  // has nothing to add and must never clobber a human verdict, so skip: no model call, no cost, no write.
  // (The poller excludes already-verdicted cards, so this only fires on that narrow race.)
  const { data: existingVerdict } = await db
    .from("card_intel_reviews")
    .select("review_card_id")
    .eq("review_card_id", card.id)
    .limit(1)
    .maybeSingle<{ review_card_id: string }>();
  if (existingVerdict) {
    await finish({ status: "done", finished_at: new Date(now()).toISOString(), error_detail: "verdict already present" });
    return "skipped";
  }

  const [{ data: grant }, { data: client }] = await Promise.all([
    db
      .from("grants")
      .select("id, title, funder, assistance_listings, program_type, eligible_entity_types, geographic_eligibility, source_url")
      .eq("id", row.grant_id)
      .maybeSingle<Grant>(),
    db.from("clients").select("*").eq("id", row.client_id).maybeSingle<Client>(),
  ]);
  if (!grant || !client) {
    await finish({ status: "done", finished_at: new Date(now()).toISOString(), error_detail: "grant/client missing" });
    return "skipped";
  }

  // The client was PAUSED (match_active=false, migration 0091) AFTER this job was enqueued. The poller
  // stops NEW enqueues for paused clients, but a job already queued must not still spend the model —
  // recheck at claim time and skip it (no cost), the same as a card that's since been decided. Reversible:
  // un-pausing re-enqueues the pair via the poller. (Codex #493 P2.) Explicit-false only, matching the
  // poller / view-filter fail-open convention: a missing/null flag never pauses (the column is NOT NULL
  // DEFAULT true in prod, so === false is exactly "deliberately paused").
  if (client.match_active === false) {
    await finish({ status: "done", finished_at: new Date(now()).toISOString(), error_detail: "client paused (match_active=false)" });
    return "skipped";
  }

  const intelCard: IntelCard = {
    fit_score: card.fit_score,
    proposed_role: card.proposed_role,
    recommended_prime: card.recommended_prime,
    why_this_org: card.why_this_org,
    before_you_approve: card.before_you_approve,
    reasoning_context: card.reasoning_context,
  };

  // Reserve the cost BEFORE the killable model call (see reserveRun) so a hard maxDuration timeout still
  // counts against the daily cap. Backfilled with the outcome below; left 'processing' if the attempt dies.
  const runLogId = randomUUID();
  await reserveRun(db, now, { runLogId, grant_id: row.grant_id, client_id: row.client_id, review_card_id: card.id, estCost });

  let review: IntelReview;
  try {
    review = await runReview(intelCard, grant, client);
  } catch (err) {
    await finalizeRun(db, now, runLogId, { verdict: "error" });
    const detail = err instanceof Error ? err.message : String(err);
    await finish(
      attemptsSoFar >= INTEL_MAX_ATTEMPTS
        ? { status: "error", finished_at: new Date(now()).toISOString(), error_detail: detail.slice(0, 600) }
        : { status: "queued", error_detail: detail.slice(0, 600) },
    );
    return "error";
  }
  await finalizeRun(db, now, runLogId, { verdict: review.verdict, searches: review.searched.length });

  // PROPOSAL-ONLY: the ONLY write is to card_intel_reviews. created_by null = the automatic pass (vs a
  // staff user id for the on-demand button). ignoreDuplicates → ON CONFLICT DO NOTHING: the pre-check above
  // catches an existing verdict, but a human on-demand verdict can still land DURING runReview; this makes
  // the write atomic so the auto pass can never overwrite it (no TOCTOU). The auto pass only ever fills a
  // gap — a re-QA after a rematch clears the row entirely, so there is no verdict to conflict with then.
  const { error: writeErr } = await db
    .from("card_intel_reviews")
    .upsert(
      { review_card_id: card.id, intel_review: review, created_by: null, updated_at: new Date(now()).toISOString() },
      { onConflict: "review_card_id", ignoreDuplicates: true },
    );
  if (writeErr) {
    await finish(
      attemptsSoFar >= INTEL_MAX_ATTEMPTS
        ? { status: "error", finished_at: new Date(now()).toISOString(), error_detail: `write: ${writeErr.message}`.slice(0, 600) }
        : { status: "queued", error_detail: `write: ${writeErr.message}`.slice(0, 600) },
    );
    return "error";
  }

  // APPLY-THE-GATE: project the verdict onto the card's qa_* OVERRIDE columns.
  // NARROW (AUTO_INTEL_APPLY_BROAD off): gated to the CFDA allowlist, and a grounded demote applies whatever
  // the refute said (refute advisory). BROAD (on): the allowlist is bypassed (any CFDA is authorized to
  // enter the block) and buildQaPatch's requireRefuteClean gate takes over — a grounded demote applies only
  // when refute_survived === true; a refute-unclean demote falls to the clearing patch (staff-flag). Either
  // way, AUTO_INTEL_APPLY OFF skips the whole block, so the master-flag-off path is byte-identical to the
  // proposal-only write above and nothing more.
  const applyAuthorized =
    autoIntelApplyEnabled() && (autoIntelApplyBroadEnabled() || cardCfdaApplyEligible(grant));
  if (applyAuthorized) {
    // Project the DURABLE verdict, and ONLY when it is an AUTO one. A human on-demand verdict can win the
    // upsert race above — it lands during runReview and ignoreDuplicates then no-ops our write, so the
    // durable record is the human's and our in-memory `review` was discarded. Projecting `review` here
    // would make the card disagree with card_intel_reviews (the source of truth); and on-demand is
    // proposal-only by design, so a human verdict is never auto-projected. Read the persisted row back and
    // apply only when created_by is null (our auto pass owns it) — using the source-of-truth verdict, not
    // the possibly-discarded `review`. (The pre-check above means our own prior verdict can't be the
    // conflict: an already-verdicted card is skipped before runReview, so a conflict here is a human one.)
    const { data: persisted } = await db
      .from("card_intel_reviews")
      .select("intel_review, created_by")
      .eq("review_card_id", card.id)
      .maybeSingle<{ intel_review: IntelReview; created_by: string | null }>();
    if (persisted && persisted.created_by === null) {
      // Every verdict yields a patch now: a demote applies (refute-clean under broad), and affirm/flag/
      // unverified — plus a refute-unclean demote under broad — CLEAR any prior applied override (so an auto
      // re-QA that reverses a demote, or downgrades a refute-clean demote to refute-unclean, leaves no stale
      // score). requireRefuteClean rides autoIntelApplyBroadEnabled(): false under narrow (byte-identical).
      await applyQaPatch(
        db,
        card.id,
        buildQaPatch(card, persisted.intel_review, new Date(now()).toISOString(), null, autoIntelApplyBroadEnabled()),
      );
    }
  }

  await finish({ status: "done", finished_at: new Date(now()).toISOString(), error_detail: null });
  return "done";
}

// Number of times to retry the qa_* projection write on a transient DB error before giving up.
const APPLY_MAX_ATTEMPTS = 3;

// Project the qa_* patch onto the card, retrying a transient DB error a few times. The verdict is already
// durable in card_intel_reviews (staff see it in the console regardless of this write), so a projection
// that STILL fails after the retries is a SOFT, never-hide degradation, not a lost verdict: the match
// stays surfaced showing the engine's own score, and it self-heals on the next rematch — which clears the
// card_intel_reviews verdict, re-enqueues the pair, and re-QAs it. There is deliberately no queue-driven
// retry of the projection alone: processOne's pre-check skips an already-verdicted card, so re-queuing this
// job would only skip; and parking the job as 'error' for a cosmetic override miss (the verdict IS durable)
// would surface a misleading hard failure. A dedicated re-projection sweep for the rare persistent case is
// PR-2 watchdog work. So: retry the transient blip, then leave it non-fatal but logged, never silent.
// Exported so the on-demand "Re-run" route (app/api/review/[id]/intel) applies its OWN verdict through the
// exact same write as the drain — one apply path, no drift. Returns whether the projection landed (the
// route surfaces `applied` so a staffer watching the card knows the score was rewritten).
export async function applyQaPatch(db: DB, cardId: string, patch: QaPatch): Promise<boolean> {
  for (let attempt = 1; attempt <= APPLY_MAX_ATTEMPTS; attempt++) {
    const { error } = await db.from("review_cards").update(patch).eq("id", cardId);
    if (!error) return true;
    if (attempt === APPLY_MAX_ATTEMPTS) {
      console.error(`[intel-apply] card ${cardId}: qa_* projection failed after ${attempt} attempts (verdict is durable in card_intel_reviews; card shows the engine score until the next rematch): ${error.message}`);
    }
  }
  return false;
}

// ── One-time BROAD backfill: project the already-computed inert demotes (the flip's companion) ────────
// Flipping AUTO_INTEL_APPLY_BROAD only changes NEW demotes: the poller skips cards that already carry a
// verdict, so the inert grounded demotes already sitting in card_intel_reviews never re-project on their
// own. This is the one-time backfill that projects them, applying the SAME broad rule the drain uses
// (grounded + refute-clean, via requireRefuteClean=true) — so it can NEVER apply a refute-unclean demote:
// those stay staff-flag exactly as the live gate leaves them. It re-projects EXISTING verdicts (no model
// call — buildQaPatch is pure), so it is COST-NEUTRAL, and IDEMPOTENT: a card whose override is already
// live is counted, never rewritten. Dry-run (apply:false) writes nothing and returns BOTH lists — the
// refute-clean set it would apply and the refute-unclean staff-flag set for a human — so staff can
// spot-check before committing. Reuses buildQaPatch/applyQaPatch (the one apply path, no drift). The route
// gates the APPLY on autoIntelApplyEnabled() (the master flag), same as the manual Re-run path; it does
// NOT read AUTO_INTEL_APPLY_BROAD — the broad rule is baked in here as requireRefuteClean=true.
export interface BackfillCardInfo {
  cardId: string;
  clientId: string | null; // for the staff console link (/clients/<clientId>/roadmap/<cardId>)
  grantTitle: string | null;
  clientName: string | null;
  engineFit: number | null;
  qaFit: number | null; // the demote's proposed (lower) score
  refuteSurvived: boolean | null;
  alreadyLive: boolean; // the override is already applied AND fresh (a re-apply would be a no-op)
}

export interface BackfillResult {
  dryRun: boolean;
  eligible: BackfillCardInfo[]; // grounded refute-CLEAN demotes — the backfill applies these
  staffFlag: BackfillCardInfo[]; // grounded refute-UNCLEAN demotes — NEVER auto-applied; a human decides
  applied: { cardId: string; engineFit: number | null; qaFit: number | null }[]; // what THIS run wrote
}

interface BackfillCardRow {
  id: string;
  fit_score: number | null;
  factor_scores: FactorScores | null;
  qa_status: string | null;
  qa_engine_fit_score: number | null;
  grant_id: string | null;
  client_id: string | null;
}

export async function backfillBroadApply(
  db: DB,
  opts: { apply?: boolean; limit?: number; cardId?: string } = {},
): Promise<BackfillResult> {
  const dryRun = opts.apply !== true;

  // The AUTO verdicts only (created_by null) — a human on-demand verdict is applied by its own route and is
  // never re-projected here (matches the drain's created_by-null reconciliation).
  const { data: reviews } = await db
    .from("card_intel_reviews")
    .select("review_card_id, intel_review, created_by")
    .is("created_by", null);
  const demotes = ((reviews ?? []) as { review_card_id: string; intel_review: IntelReview }[]).filter(
    (r) => r.intel_review?.verdict === "demote" && r.intel_review?.qa_fit_score != null,
  );
  if (demotes.length === 0) return { dryRun, eligible: [], staffFlag: [], applied: [] };

  // The cards behind those demotes: the engine score + factors for the patch, the qa_* columns for the
  // already-live check. GATED to pending + unreleased, the SAME invariant processOne enforces before any
  // apply-write — so the backfill can never retroactively rewrite the score/factors/narrative shown on a
  // card a staffer already DECIDED on or that was already RELEASED / sent to a client (the "preview == sent"
  // / decision-integrity invariant). A decided/released card has no row here → it drops out of eligible and
  // is never applied. A demote whose card was deleted / re-scored away is likewise absent and skipped.
  const cardIds = demotes.map((d) => d.review_card_id);
  const { data: cardRows } = await db
    .from("review_cards")
    .select("id, fit_score, factor_scores, qa_status, qa_engine_fit_score, grant_id, client_id")
    .in("id", cardIds)
    .eq("decision", "pending")
    .is("sme_released_at", null);
  const cards = new Map(((cardRows ?? []) as BackfillCardRow[]).map((c) => [c.id, c]));

  // Grant title + client name so a reviewer can recognize the card in the dry-run list.
  const grantIds = [...new Set([...cards.values()].map((c) => c.grant_id).filter((x): x is string => !!x))];
  const clientIds = [...new Set([...cards.values()].map((c) => c.client_id).filter((x): x is string => !!x))];
  const [{ data: grantRows }, { data: clientRows }] = await Promise.all([
    grantIds.length
      ? db.from("grants").select("id, title").in("id", grantIds)
      : Promise.resolve({ data: [] as { id: string; title: string | null }[] }),
    clientIds.length
      ? db.from("clients").select("id, name").in("id", clientIds)
      : Promise.resolve({ data: [] as { id: string; name: string | null }[] }),
  ]);
  const grantTitle = new Map(((grantRows ?? []) as { id: string; title: string | null }[]).map((g) => [g.id, g.title]));
  const clientName = new Map(((clientRows ?? []) as { id: string; name: string | null }[]).map((c) => [c.id, c.name]));

  const eligible: BackfillCardInfo[] = [];
  const staffFlag: BackfillCardInfo[] = [];
  for (const d of demotes) {
    const card = cards.get(d.review_card_id);
    if (!card) continue;
    const info: BackfillCardInfo = {
      cardId: d.review_card_id,
      clientId: card.client_id ?? null,
      grantTitle: card.grant_id ? grantTitle.get(card.grant_id) ?? null : null,
      clientName: card.client_id ? clientName.get(card.client_id) ?? null : null,
      engineFit: card.fit_score,
      qaFit: d.intel_review.qa_fit_score,
      refuteSurvived: d.intel_review.refute_survived,
      alreadyLive: card.qa_status === "applied" && card.qa_engine_fit_score === card.fit_score,
    };
    (d.intel_review.refute_survived === true ? eligible : staffFlag).push(info);
  }

  const applied: BackfillResult["applied"] = [];
  if (!dryRun) {
    const limit = opts.limit ?? eligible.length;
    for (const info of eligible) {
      if (applied.length >= limit) break;
      if (opts.cardId && info.cardId !== opts.cardId) continue;
      if (info.alreadyLive) continue; // idempotent: a live override is never rewritten
      const card = cards.get(info.cardId);
      if (!card) continue;
      // RE-READ the verdict at WRITE time (mirrors processOne + the on-demand route, PR G): a staff Re-run
      // could have landed on this card since the initial fetch and written a HUMAN verdict — never overwrite
      // it with our now-stale AUTO one. Apply only while the row is STILL the auto (created_by null),
      // refute-clean demote we captured; otherwise skip and leave the human's verdict standing.
      const { data: persisted } = await db
        .from("card_intel_reviews")
        .select("intel_review, created_by")
        .eq("review_card_id", info.cardId)
        .maybeSingle<{ intel_review: IntelReview; created_by: string | null }>();
      if (!persisted || persisted.created_by !== null) continue;
      const review = persisted.intel_review;
      if (review?.verdict !== "demote" || review?.refute_survived !== true) continue;
      const patch = buildQaPatch(
        { id: card.id, fit_score: card.fit_score, factor_scores: card.factor_scores },
        review,
        new Date().toISOString(),
        null,
        true, // requireRefuteClean — the broad rule; the re-read verdict is refute-clean, so this applies
      );
      if (await applyQaPatch(db, info.cardId, patch)) {
        applied.push({ cardId: info.cardId, engineFit: info.engineFit, qaFit: info.qaFit });
      }
    }
  }

  return { dryRun, eligible, staffFlag, applied };
}

// Reserve the estimated cost in the run log BEFORE the killable model call, returning the row id. This is
// what makes the daily cap hold against OUT-OF-PROCESS kills: a Vercel maxDuration=300s timeout (or OOM /
// crash) during runReview never reaches processOne's catch, so a log written only AFTER the pass would miss
// that attempt's real Opus+web spend and dailySpentUsd (which sums ONLY this ledger) would under-count,
// letting real spend blow past INTEL_AUTO_DAILY_CAP_USD. Reserving first means a killed attempt still
// counts. The id is generated here (not the DB default) so the caller can backfill the verdict without an
// insert-returning round-trip. A failed insert is surfaced, not silently dropped (the sibling finding).
async function reserveRun(
  db: DB,
  now: () => number,
  r: { runLogId: string; grant_id: string; client_id: string; review_card_id: string; estCost: number },
): Promise<void> {
  const { error } = await db.from("intel_auto_run_log").insert({
    id: r.runLogId,
    grant_id: r.grant_id,
    client_id: r.client_id,
    review_card_id: r.review_card_id,
    verdict: "processing", // backfilled by finalizeRun; stays 'processing' if the attempt is killed
    searches: 0,
    cost_estimate_usd: r.estCost,
    ran_at: new Date(now()).toISOString(),
  });
  if (error) console.error("[auto-intel] reserveRun failed (cost may be under-counted)", error);
}

// Backfill the reserved run-log row with the outcome once the pass resolves (or throws in-process). Cost is
// unchanged — it was counted at reservation. A no-op if the reserve insert failed (0 rows match the id).
async function finalizeRun(
  db: DB,
  now: () => number,
  runLogId: string,
  r: { verdict: string; searches?: number },
): Promise<void> {
  const { error } = await db
    .from("intel_auto_run_log")
    .update({ verdict: r.verdict, searches: r.searches ?? 0, ran_at: new Date(now()).toISOString() })
    .eq("id", runLogId);
  if (error) console.error("[auto-intel] finalizeRun failed", error);
}

// The real QA pass, with no reviewer (the automatic run) — the on-demand route passes the staff user id.
function defaultRunReview(card: IntelCard, grant: Grant, client: Client): Promise<IntelReview> {
  return runIntelReview(card, grant, client, { reviewedBy: null });
}

// One entry point for the cron: poll then drain, honoring the flag. OFF → no work, byte-identical.
export async function runAutoIntel(db: DB, opts: DrainOptions = {}): Promise<DrainResult> {
  if (!autoIntelEnabled()) {
    return { enqueued: 0, processed: 0, done: 0, skipped: 0, errored: 0, reclaimed: 0, capReached: false, spentTodayUsd: 0 };
  }
  const enqueued = await pollAndEnqueue(db, { now: opts.now });
  const drained = await drainIntelQueue(db, opts);
  return { enqueued, ...drained };
}
