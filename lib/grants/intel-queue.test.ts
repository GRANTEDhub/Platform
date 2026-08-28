import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { pollAndEnqueue, drainIntelQueue, runAutoIntel, INTEL_MAX_ATTEMPTS, buildQaPatch, applyQaPatch, cardCfdaApplyEligible } from "./intel-queue";
import type { IntelReview } from "./intel-review";

// Deterministic — NO model, NO network, NO real Supabase. A tiny in-memory fake DB implements just the
// query chains intel-queue.ts uses, so we can lock the invariants:
//   - eligibility (only pending, unreleased, CLIENT cards with no verdict and no live queue job enqueue)
//   - PROPOSAL-ONLY (the drain writes card_intel_reviews ONLY — review_cards is never touched)
//   - the daily COST CAP stops work
//   - status transitions (queued → processing → done/error) and the "card no longer pending" skip
//   - the flag gate (OFF = no work, no model call)

// ── A minimal chainable fake of the subset of supabase-js we call ──────────────────────────────────
type Row = Record<string, unknown>;
class Query {
  private rows: Row[];
  private filters: ((r: Row) => boolean)[] = [];
  private op: "select" | "update" | "upsert" | "insert" = "select";
  private patch: Row = {};
  private inserts: Row[] = [];
  private onConflict: string[] = [];
  private ignoreDuplicates = false;
  private single = false;
  private selectAfterWrite = false;
  private orderBy: { col: string; asc: boolean } | null = null;
  private lim: number | null = null;
  private rangeFromTo: { from: number; to: number } | null = null;
  constructor(private store: Store, private table: string) {
    this.rows = store.tables[table] ?? (store.tables[table] = []);
  }
  select(_cols?: string) { if (this.op === "update") this.selectAfterWrite = true; return this; }
  eq(col: string, val: unknown) { this.filters.push((r) => r[col] === val); return this; }
  is(col: string, val: unknown) { this.filters.push((r) => (r[col] ?? null) === val); return this; }
  not(col: string, _op: string, val: unknown) { this.filters.push((r) => (r[col] ?? null) !== val); return this; }
  in(col: string, arr: unknown[]) { this.filters.push((r) => arr.includes(r[col])); return this; }
  gte(col: string, val: unknown) { this.filters.push((r) => String(r[col]) >= String(val)); return this; }
  lt(col: string, val: unknown) { this.filters.push((r) => String(r[col]) < String(val)); return this; }
  order(col: string, o?: { ascending?: boolean }) { this.orderBy = { col, asc: o?.ascending !== false }; return this; }
  limit(n: number) { this.lim = n; return this; }
  range(from: number, to: number) { this.rangeFromTo = { from, to }; return this; }
  returns() { return this; }
  update(patch: Row) { this.op = "update"; this.patch = patch; return this; }
  upsert(rows: Row | Row[], opts?: { onConflict?: string; ignoreDuplicates?: boolean }) { this.op = "upsert"; this.inserts = Array.isArray(rows) ? rows : [rows]; this.onConflict = (opts?.onConflict ?? "").split(",").map((s) => s.trim()).filter(Boolean); this.ignoreDuplicates = opts?.ignoreDuplicates ?? false; return this; }
  insert(rows: Row | Row[]) { this.op = "insert"; this.inserts = Array.isArray(rows) ? rows : [rows]; return this; }
  maybeSingle() { this.single = true; return this.exec(); }
  private matched(): Row[] {
    let out = this.rows.filter((r) => this.filters.every((f) => f(r)));
    if (this.orderBy) { const { col, asc } = this.orderBy; out = [...out].sort((a, b) => (String(a[col]) < String(b[col]) ? -1 : 1) * (asc ? 1 : -1)); }
    if (this.rangeFromTo) out = out.slice(this.rangeFromTo.from, this.rangeFromTo.to + 1);
    else if (this.lim != null) out = out.slice(0, this.lim);
    return out;
  }
  private exec(): Promise<{ data: unknown; error: { message: string } | null }> {
    // Real supabase returns DETACHED rows: a later .update(...).eq("id", …) mutates the DB, never the JS
    // object an earlier SELECT handed you. The fake must copy on read too, else a claimed row's in-memory
    // `attempts` would appear pre-incremented and mask the retry-cap off-by-one this suite locks.
    if (this.op === "select") {
      const m = this.matched().map((r) => ({ ...r }));
      return Promise.resolve({ data: this.single ? (m[0] ?? null) : m, error: null });
    }
    if (this.op === "update") {
      // Inject a transient failure on the Nth update to this table (locks the apply-write retry path).
      if ((this.store.updateFailures[this.table] ?? 0) > 0) {
        this.store.updateFailures[this.table]--;
        return Promise.resolve({ data: null, error: { message: "transient db error" } });
      }
      const m = this.matched();
      for (const r of m) Object.assign(r, this.patch);
      return Promise.resolve({ data: this.selectAfterWrite ? m.map((r) => ({ ...r })) : null, error: null });
    }
    if (this.op === "insert") { for (const r of this.inserts) this.rows.push({ ...r }); return Promise.resolve({ data: null, error: null }); }
    // upsert. ignoreDuplicates → ON CONFLICT DO NOTHING (leave the existing row untouched).
    for (const nr of this.inserts) {
      const existing = this.onConflict.length ? this.rows.find((r) => this.onConflict.every((k) => r[k] === nr[k])) : undefined;
      if (existing) { if (!this.ignoreDuplicates) Object.assign(existing, nr); }
      else this.rows.push({ ...nr });
    }
    return Promise.resolve({ data: null, error: null });
  }
  then<T>(res: (v: { data: unknown; error: { message: string } | null }) => T) { return this.exec().then(res); }
}
class Store {
  tables: Record<string, Row[]> = {};
  // Test hook: number of upcoming .update()s to a given table that should return a transient error.
  updateFailures: Record<string, number> = {};
  from(table: string) { return new Query(this, table); }
}
const db = () => new Store();
// The fake implements only the subset of the client the queue module uses; cast to the DB param type.
const asDb = (s: Store) => s as unknown as Parameters<typeof pollAndEnqueue>[0];

const NOW = Date.parse("2026-08-27T12:00:00.000Z");
const now = () => NOW;

const okReview = (verdict: IntelReview["verdict"] = "affirm", searches = 0): IntelReview => ({
  verdict, confidence: "high", engine_fit_score: 3, qa_fit_score: verdict === "affirm" ? 3 : null, qa_factor_scores: null,
  summary: "s", narrative: null, evidence: [], fetched: [], searched: Array(searches).fill("q"), refute_survived: null,
  unverified: false, model: "claude-opus-5", reviewed_by: null, reviewed_at: "T",
});

const pendingCard = (over: Row = {}): Row => ({
  id: "card-1", grant_id: "g1", client_id: "c1", decision: "pending", sme_released_at: null, card_type: "client",
  created_at: "2026-08-27T10:00:00Z", fit_score: 3, proposed_role: "Prime", recommended_prime: null,
  why_this_org: [], before_you_approve: [], reasoning_context: null, ...over,
});

function seedPairData(s: Store) {
  s.tables.grants = [{ id: "g1", title: "JAG", assistance_listings: [{ number: "16.738" }], source_url: "https://x.gov" }];
  s.tables.clients = [{ id: "c1", name: "Mississippi County", org_type: "local_government" }];
}

describe("pollAndEnqueue — eligibility", () => {
  it("enqueues an eligible pending client card with no verdict and no live job", async () => {
    const s = db(); s.tables.review_cards = [pendingCard()];
    const n = await pollAndEnqueue(asDb(s), { now });
    expect(n).toBe(1);
    expect(s.tables.intel_review_queue).toHaveLength(1);
    expect(s.tables.intel_review_queue[0]).toMatchObject({ grant_id: "g1", client_id: "c1", status: "queued" });
  });

  it("skips a card that already has a QA verdict", async () => {
    const s = db(); s.tables.review_cards = [pendingCard()]; s.tables.card_intel_reviews = [{ review_card_id: "card-1" }];
    expect(await pollAndEnqueue(asDb(s), { now })).toBe(0);
    expect(s.tables.intel_review_queue ?? []).toHaveLength(0);
  });

  it("skips a pair that already has a live (queued/processing) job", async () => {
    const s = db(); s.tables.review_cards = [pendingCard()]; s.tables.intel_review_queue = [{ grant_id: "g1", client_id: "c1", status: "processing" }];
    expect(await pollAndEnqueue(asDb(s), { now })).toBe(0);
    expect(s.tables.intel_review_queue).toHaveLength(1);
  });

  it("re-enqueues a pair whose prior job is 'done' (verdict was cleared, e.g. by a rematch)", async () => {
    const s = db(); s.tables.review_cards = [pendingCard()]; s.tables.intel_review_queue = [{ grant_id: "g1", client_id: "c1", status: "done" }];
    expect(await pollAndEnqueue(asDb(s), { now })).toBe(1);
    expect(s.tables.intel_review_queue).toHaveLength(1); // upsert reset it in place
    expect(s.tables.intel_review_queue[0].status).toBe("queued");
  });

  it("does NOT re-enqueue a pair whose prior job is parked 'error' (backstop holds — no budget-burn loop)", async () => {
    // A persistently-failing card wrote no verdict, so the has-verdict check can't catch it; the 'error'
    // status must. Re-queuing it would resurrect it every poll and burn the daily cap forever.
    const s = db(); s.tables.review_cards = [pendingCard()];
    s.tables.intel_review_queue = [{ grant_id: "g1", client_id: "c1", status: "error", attempts: INTEL_MAX_ATTEMPTS }];
    expect(await pollAndEnqueue(asDb(s), { now })).toBe(0);
    expect(s.tables.intel_review_queue).toHaveLength(1);
    expect(s.tables.intel_review_queue[0].status).toBe("error"); // stays parked, not resurrected to queued
  });

  it("polls oldest-first (FIFO) so a sustained backlog beyond the limit can't starve older cards", async () => {
    const s = db();
    s.tables.review_cards = [
      pendingCard({ id: "new", client_id: "c-new", created_at: "2026-08-27T12:00:00Z" }),
      pendingCard({ id: "mid", client_id: "c-mid", created_at: "2026-08-27T11:00:00Z" }),
      pendingCard({ id: "old", client_id: "c-old", created_at: "2026-08-27T10:00:00Z" }),
    ];
    const n = await pollAndEnqueue(asDb(s), { now, limit: 2 });
    expect(n).toBe(2);
    const clients = (s.tables.intel_review_queue ?? []).map((r) => r.client_id).sort();
    expect(clients).toEqual(["c-mid", "c-old"]); // the two OLDEST, never the newest
  });

  it("pages past a wall of already-verdicted / error-parked oldest cards to reach an eligible newer one", async () => {
    // The 2 oldest pending cards are blocked (one has a verdict, one is terminally error-parked); an
    // eligible newer card sits behind them. A single fixed oldest-2 window + post-filter would return
    // eligible=[] every cycle and starve the newer card forever — pagination must advance past the wall.
    const s = db();
    s.tables.review_cards = [
      pendingCard({ id: "old-verdicted", client_id: "c1", created_at: "2026-08-27T10:00:00Z" }),
      pendingCard({ id: "old-errored", client_id: "c2", created_at: "2026-08-27T10:30:00Z" }),
      pendingCard({ id: "new-eligible", client_id: "c3", created_at: "2026-08-27T11:00:00Z" }),
    ];
    s.tables.card_intel_reviews = [{ review_card_id: "old-verdicted" }];
    s.tables.intel_review_queue = [{ grant_id: "g1", client_id: "c2", status: "error", attempts: INTEL_MAX_ATTEMPTS }];
    const n = await pollAndEnqueue(asDb(s), { now, limit: 2 });
    expect(n).toBe(1);
    const queued = s.tables.intel_review_queue.filter((r) => r.status === "queued");
    expect(queued).toHaveLength(1);
    expect(queued[0].client_id).toBe("c3"); // the eligible card behind the wall got enqueued
  });

  it("dedups a (grant, client) pair with two pending cards into a single queue row", async () => {
    // Two pending cards for the same pair would otherwise put the same conflict key twice in one upsert
    // payload — which Postgres rejects. The poller collapses them to one enqueue.
    const s = db();
    s.tables.review_cards = [
      pendingCard({ id: "card-a", client_id: "c1", created_at: "2026-08-27T10:00:00Z" }),
      pendingCard({ id: "card-b", client_id: "c1", created_at: "2026-08-27T10:30:00Z" }),
    ];
    expect(await pollAndEnqueue(asDb(s), { now })).toBe(1);
    expect(s.tables.intel_review_queue).toHaveLength(1);
  });

  it("skips prospect / decided / released cards", async () => {
    const s = db();
    s.tables.review_cards = [
      pendingCard({ id: "p", card_type: "prospect", client_id: null }),
      pendingCard({ id: "d", decision: "approved" }),
      pendingCard({ id: "r", sme_released_at: "2026-08-27T11:00:00Z" }),
    ];
    expect(await pollAndEnqueue(asDb(s), { now })).toBe(0);
  });
});

describe("drainIntelQueue — proposal-only + transitions", () => {
  let s: Store;
  beforeEach(() => {
    s = db();
    seedPairData(s);
    s.tables.review_cards = [pendingCard()];
    s.tables.intel_review_queue = [{ id: "q1", grant_id: "g1", client_id: "c1", status: "queued", attempts: 0, enqueued_at: "2026-08-27T11:00:00Z" }];
  });

  it("runs QA, writes card_intel_reviews ONLY (never review_cards), marks the job done, logs cost", async () => {
    const before = JSON.stringify(s.tables.review_cards);
    const r = await drainIntelQueue(asDb(s), { now, runReview: async () => okReview("demote", 2) });
    expect(r.done).toBe(1);
    expect(JSON.stringify(s.tables.review_cards)).toBe(before); // PROPOSAL-ONLY: review_cards untouched
    expect(s.tables.card_intel_reviews).toHaveLength(1);
    expect(s.tables.card_intel_reviews[0]).toMatchObject({ review_card_id: "card-1", created_by: null });
    expect(s.tables.intel_review_queue[0].status).toBe("done");
    expect(s.tables.intel_auto_run_log).toHaveLength(1);
    expect(s.tables.intel_auto_run_log[0]).toMatchObject({ verdict: "demote", searches: 2 });
  });

  it("reserves the cost in the run log BEFORE running QA (a hard timeout still counts against the cap)", async () => {
    let logCountDuringRun = -1;
    await drainIntelQueue(asDb(s), {
      now,
      runReview: async () => {
        logCountDuringRun = (s.tables.intel_auto_run_log ?? []).length; // the row must already exist
        return okReview("affirm");
      },
    });
    expect(logCountDuringRun).toBe(1); // reserved before runReview ran (logging only after would be 0)
    expect(s.tables.intel_auto_run_log[0]).toMatchObject({ cost_estimate_usd: 0.3 }); // cost counted
    expect(s.tables.intel_auto_run_log[0]).toMatchObject({ verdict: "affirm" }); // backfilled after
  });

  it("marks a job done+skipped (no model call) when the card is no longer pending", async () => {
    s.tables.review_cards = [pendingCard({ decision: "approved" })]; // decided since enqueue
    let called = false;
    const r = await drainIntelQueue(asDb(s), { now, runReview: async () => { called = true; return okReview(); } });
    expect(called).toBe(false);
    expect(r.skipped).toBe(1);
    expect(s.tables.intel_review_queue[0].status).toBe("done");
    expect(s.tables.card_intel_reviews ?? []).toHaveLength(0);
  });

  it("skips (no model call) when a verdict already exists — never clobbers a staff on-demand verdict", async () => {
    // A staffer ran the on-demand Intel pass (created_by = their id) while this auto job waited.
    s.tables.card_intel_reviews = [{ review_card_id: "card-1", created_by: "user-x", intel_review: { verdict: "affirm" } }];
    let called = false;
    const r = await drainIntelQueue(asDb(s), { now, runReview: async () => { called = true; return okReview("demote"); } });
    expect(called).toBe(false); // pre-check short-circuits before the model call
    expect(r.skipped).toBe(1);
    expect(s.tables.card_intel_reviews).toHaveLength(1);
    expect(s.tables.card_intel_reviews[0]).toMatchObject({ created_by: "user-x" }); // human verdict preserved
    expect(s.tables.intel_review_queue[0].status).toBe("done");
  });

  it("write-level guard: a verdict landing DURING the QA run is not clobbered (ON CONFLICT DO NOTHING)", async () => {
    // No verdict at pre-check time; a human verdict lands while runReview is in flight (the residual race).
    const r = await drainIntelQueue(asDb(s), {
      now,
      runReview: async () => {
        s.tables.card_intel_reviews = [{ review_card_id: "card-1", created_by: "user-y", intel_review: { verdict: "affirm" } }];
        return okReview("demote");
      },
    });
    expect(r.done).toBe(1);
    expect(s.tables.card_intel_reviews).toHaveLength(1);
    expect(s.tables.card_intel_reviews[0]).toMatchObject({ created_by: "user-y" }); // not overwritten by created_by:null
  });

  it("reclaim parks a stale 'processing' job as 'error' once it has used its attempts (out-of-process kill)", async () => {
    // A job killed by the platform mid-run (processOne's catch never fired) sits 'processing' with attempts
    // already at the cap. Started long enough ago to be stale. Cap the day so the drain stops right after
    // the reclaim, isolating its effect.
    const longAgo = new Date(NOW - 60 * 60 * 1000).toISOString(); // 1h ago > 20min stale threshold
    s.tables.intel_auto_run_log = [{ cost_estimate_usd: 30, ran_at: "2026-08-27T09:00:00Z" }]; // at cap
    s.tables.intel_review_queue = [
      { id: "capped", grant_id: "g1", client_id: "c1", status: "processing", attempts: INTEL_MAX_ATTEMPTS, started_at: longAgo, enqueued_at: longAgo },
      { id: "under", grant_id: "g2", client_id: "c2", status: "processing", attempts: INTEL_MAX_ATTEMPTS - 1, started_at: longAgo, enqueued_at: longAgo },
    ];
    const r = await drainIntelQueue(asDb(s), { now, runReview: async () => okReview() });
    const status = Object.fromEntries(s.tables.intel_review_queue.map((row) => [row.id, row.status]));
    expect(status["capped"]).toBe("error"); // used its attempts → parked, not resurrected forever
    expect(status["under"]).toBe("queued"); // still has a retry → requeued
    expect(r.reclaimed).toBe(1); // only the under-cap one counts as reclaimed
    expect(r.errored).toBe(1); // the capped one is surfaced as an error
  });

  it("stops at the daily cost cap (does no work, capReached)", async () => {
    // Already spent 30 today → at the default 30 cap.
    s.tables.intel_auto_run_log = [{ cost_estimate_usd: 30, ran_at: "2026-08-27T09:00:00Z" }];
    let called = false;
    const r = await drainIntelQueue(asDb(s), { now, runReview: async () => { called = true; return okReview(); } });
    expect(r.capReached).toBe(true);
    expect(called).toBe(false);
    expect(s.tables.intel_review_queue[0].status).toBe("queued"); // untouched
  });

  it("on a model error: logs the cost (bounds a failing loop) and requeues below the attempt cap", async () => {
    const r = await drainIntelQueue(asDb(s), { now, runReview: async () => { throw new Error("boom"); } });
    expect(r.errored).toBe(1);
    expect(s.tables.intel_review_queue[0].status).toBe("queued"); // attempts 1 < max → retry
    expect(s.tables.intel_auto_run_log[0]).toMatchObject({ verdict: "error" }); // cost still counted
  });

  it("parks as 'error' ON the INTEL_MAX_ATTEMPTS-th attempt, not one later", async () => {
    // attempts = MAX-1 before this run; the claim increments to MAX, so THIS is the MAX-th (final) attempt.
    s.tables.intel_review_queue[0].attempts = INTEL_MAX_ATTEMPTS - 1;
    const r = await drainIntelQueue(asDb(s), { now, runReview: async () => { throw new Error("boom"); } });
    expect(r.errored).toBe(1);
    expect(s.tables.intel_review_queue[0].status).toBe("error");
  });

  it("does NOT park one attempt early (retry-cap is judged post-increment)", async () => {
    // attempts = MAX-2 → this run is only the (MAX-1)-th attempt, so one retry must remain.
    s.tables.intel_review_queue[0].attempts = INTEL_MAX_ATTEMPTS - 2;
    const r = await drainIntelQueue(asDb(s), { now, runReview: async () => { throw new Error("boom"); } });
    expect(r.errored).toBe(1);
    expect(s.tables.intel_review_queue[0].status).toBe("queued"); // requeued, not parked
  });
});

describe("runAutoIntel — flag gate", () => {
  const prev = process.env.AUTO_INTEL_ENABLED;
  afterEach(() => { if (prev === undefined) delete process.env.AUTO_INTEL_ENABLED; else process.env.AUTO_INTEL_ENABLED = prev; });

  it("OFF → no work, no model call (byte-identical to today)", async () => {
    delete process.env.AUTO_INTEL_ENABLED;
    const s = db(); seedPairData(s); s.tables.review_cards = [pendingCard()];
    let called = false;
    const r = await runAutoIntel(asDb(s), { now, runReview: async () => { called = true; return okReview(); } });
    expect(called).toBe(false);
    expect(r).toMatchObject({ enqueued: 0, processed: 0 });
    expect(s.tables.intel_review_queue ?? []).toHaveLength(0);
  });

  it("ON → polls, enqueues, and drains in one pass", async () => {
    process.env.AUTO_INTEL_ENABLED = "true";
    const s = db(); seedPairData(s); s.tables.review_cards = [pendingCard()];
    const r = await runAutoIntel(asDb(s), { now, runReview: async () => okReview("affirm") });
    expect(r.enqueued).toBe(1);
    expect(r.done).toBe(1);
    expect(s.tables.card_intel_reviews).toHaveLength(1);
  });
});

// ── Apply-the-gate (Step 3, PR B) ────────────────────────────────────────────────────────────────
const engineFactors = {
  seat_role: { rating: "moderate", rationale: "seat" },
  eligibility: { rating: "moderate", rationale: "elig" },
  geographic: { rating: "strong", rationale: "in-state" },
  program_history: { rating: "moderate", rationale: "some" },
  cost_share: { rating: "strong", rationale: "n/a" },
  mission: { rating: "strong", rationale: "aligned" },
};
const JAG_PDF = "https://bja.ojp.gov/funding/fy26-jag-local-allocations-ar.pdf";
// A demote verdict as the QA pass returns it: qa_factor_scores is a PARTIAL (only the changed factor).
const demoteReview = (over: Partial<IntelReview> = {}): IntelReview => ({
  verdict: "demote", confidence: "high", engine_fit_score: 3, qa_fit_score: 2,
  qa_factor_scores: { seat_role: { rating: "weak", rationale: "asterisk — cannot prime" } } as IntelReview["qa_factor_scores"],
  summary: "asterisk county", narrative: null, evidence: [],
  fetched: [{ url: JAG_PDF, ok: true, finalUrl: JAG_PDF, truncated: false, fetchedAt: "T" }],
  searched: [], refute_survived: true, unverified: false, model: "claude-opus-5", reviewed_by: null, reviewed_at: "T",
  ...over,
});
const rating = (o: unknown, k: string): string => (o as Record<string, { rating: string }>)[k].rating;

describe("apply-the-gate — buildQaPatch + cardCfdaApplyEligible (pure)", () => {
  const card = { id: "card-1", fit_score: 3, factor_scores: engineFactors as never };

  it("cardCfdaApplyEligible: JAG 16.738 (+ letter suffix) → true; anything else / empty → false", () => {
    expect(cardCfdaApplyEligible({ assistance_listings: [{ number: "16.738" }] } as never)).toBe(true);
    expect(cardCfdaApplyEligible({ assistance_listings: [{ number: "16.738A" }] } as never)).toBe(true);
    expect(cardCfdaApplyEligible({ assistance_listings: [{ number: "16.575" }] } as never)).toBe(false);
    expect(cardCfdaApplyEligible({ assistance_listings: [] } as never)).toBe(false);
    expect(cardCfdaApplyEligible({ assistance_listings: null } as never)).toBe(false);
  });

  it("demote → applied patch: merged factors, deduped grounded sources, engine-score snapshot", () => {
    const patch = buildQaPatch(card, demoteReview(), "2026-08-27T12:00:00Z");
    expect(patch).not.toBeNull();
    expect(patch!.qa_status).toBe("applied");
    expect(patch!.qa_fit_score).toBe(2);
    expect(patch!.qa_engine_fit_score).toBe(3); // snapshot for the read-layer staleness check
    expect(patch!.qa_reviewed_by).toBeNull();
    // MERGE: QA's changed seat_role overlaid on the engine's real five (never the fabricated ones)
    expect(rating(patch!.qa_factor_scores, "seat_role")).toBe("weak");
    expect(rating(patch!.qa_factor_scores, "eligibility")).toBe("moderate"); // carried from engine
    expect(rating(patch!.qa_factor_scores, "mission")).toBe("strong"); // carried from engine
    expect(patch!.qa_sources).toEqual([JAG_PDF]);
  });

  it("INVARIANT: every key of the patch is qa_-prefixed — buildQaPatch can never name an engine column", () => {
    for (const v of ["demote", "unverified"] as const) {
      const patch = buildQaPatch(card, demoteReview({ verdict: v, qa_fit_score: v === "demote" ? 2 : null }), "T")!;
      for (const k of Object.keys(patch)) expect(k.startsWith("qa_")).toBe(true);
    }
  });

  it("unverified → qa_status 'unverified' + every score/factor/source column NULLED (clears a stale demote)", () => {
    const patch = buildQaPatch(card, demoteReview({ verdict: "unverified", qa_fit_score: null, qa_factor_scores: null, unverified: true }), "T")!;
    expect(patch.qa_status).toBe("unverified");
    // The fail-safe must actively clear any prior applied-demote override — not just flip the status —
    // else a demoted-then-re-QA'd card keeps showing the stale score under the read-layer coalesce.
    expect(patch.qa_fit_score).toBeNull();
    expect(patch.qa_factor_scores).toBeNull();
    expect(patch.qa_sources).toBeNull();
    expect(patch.qa_engine_fit_score).toBeNull();
  });

  it("affirm and flag → a CLEARING patch (qa_status 'none', score columns nulled) so a reversal clears a prior demote", () => {
    for (const v of ["affirm", "flag"] as const) {
      const patch = buildQaPatch(card, demoteReview({ verdict: v, qa_fit_score: v === "affirm" ? 3 : null, qa_factor_scores: null }), "T");
      expect(patch.qa_status).toBe("none"); // agrees / concern-only — no override in effect
      // A demoted-then-reversed card must clear, else the stale demoted score keeps showing under coalesce.
      expect(patch.qa_fit_score).toBeNull();
      expect(patch.qa_factor_scores).toBeNull();
      expect(patch.qa_sources).toBeNull();
      expect(patch.qa_engine_fit_score).toBeNull();
    }
  });

  it("reviewedBy stamps qa_reviewed_by (manual apply audit); default is null (the auto pass)", () => {
    // Default (drain): null.
    expect(buildQaPatch(card, demoteReview(), "T")!.qa_reviewed_by).toBeNull();
    // Manual Re-run: the acting staff id, on both the demote and the unverified branch.
    expect(buildQaPatch(card, demoteReview(), "T", "staff-9")!.qa_reviewed_by).toBe("staff-9");
    expect(
      buildQaPatch(card, demoteReview({ verdict: "unverified", qa_fit_score: null, qa_factor_scores: null, unverified: true }), "T", "staff-9")!
        .qa_reviewed_by,
    ).toBe("staff-9");
  });
});

describe("applyQaPatch — writes the patch, returns whether it landed", () => {
  const patch = { qa_fit_score: 2, qa_status: "applied" as const, qa_applied_at: "T", qa_reviewed_by: "staff-9" };

  it("success → updates the row and returns true", async () => {
    const s = db();
    s.tables.review_cards = [pendingCard()];
    const ok = await applyQaPatch(asDb(s), "card-1", patch);
    expect(ok).toBe(true);
    expect(s.tables.review_cards[0].qa_fit_score).toBe(2);
    expect(s.tables.review_cards[0].qa_reviewed_by).toBe("staff-9");
  });

  it("persistent DB error → returns false, non-throwing (verdict stays durable elsewhere)", async () => {
    const s = db();
    s.tables.review_cards = [pendingCard()];
    s.updateFailures.review_cards = 99;
    const ok = await applyQaPatch(asDb(s), "card-1", patch);
    expect(ok).toBe(false);
    expect(s.tables.review_cards[0].qa_fit_score ?? null).toBeNull();
  });
});

describe("drainIntelQueue — apply-the-gate flag + allowlist (AUTO_INTEL_APPLY)", () => {
  const prev = process.env.AUTO_INTEL_APPLY;
  afterEach(() => { if (prev === undefined) delete process.env.AUTO_INTEL_APPLY; else process.env.AUTO_INTEL_APPLY = prev; });

  const seed = () => {
    const s = db(); seedPairData(s); // grant g1 carries CFDA 16.738 (JAG)
    s.tables.review_cards = [pendingCard({ factor_scores: engineFactors })];
    s.tables.intel_review_queue = [{ id: "q1", grant_id: "g1", client_id: "c1", status: "queued", attempts: 0, enqueued_at: "2026-08-27T11:00:00Z" }];
    return s;
  };

  it("OFF (default) → review_cards untouched even on a JAG demote (byte-identical to today)", async () => {
    delete process.env.AUTO_INTEL_APPLY;
    const s = seed();
    await drainIntelQueue(asDb(s), { now, runReview: async () => demoteReview() });
    const card = s.tables.review_cards[0];
    expect(card.qa_fit_score ?? null).toBeNull();
    expect(card.qa_status ?? null).toBeNull();
    expect(card.fit_score).toBe(3);
    expect(s.tables.card_intel_reviews).toHaveLength(1); // verdict still stored (proposal path)
  });

  it("ON + JAG demote → writes ONLY qa_* columns; engine fit_score / factor_scores / decision UNTOUCHED", async () => {
    process.env.AUTO_INTEL_APPLY = "true";
    const s = seed();
    await drainIntelQueue(asDb(s), { now, runReview: async () => demoteReview() });
    const card = s.tables.review_cards[0];
    // qa_* override projected
    expect(card.qa_fit_score).toBe(2);
    expect(card.qa_status).toBe("applied");
    expect(card.qa_engine_fit_score).toBe(3);
    expect(rating(card.qa_factor_scores, "seat_role")).toBe("weak");
    // NEVER-HIDE / proposal-safety: the engine's own columns are untouched, and the row still exists (surfaced)
    expect(card.fit_score).toBe(3);
    expect(rating(card.factor_scores, "seat_role")).toBe("moderate");
    expect(card.decision).toBe("pending");
    expect(card.sme_released_at ?? null).toBeNull();
  });

  it("ON + NON-JAG (VOCA 16.575) demote → review_cards untouched (allowlist keeps it proposal-only)", async () => {
    process.env.AUTO_INTEL_APPLY = "true";
    const s = seed();
    s.tables.grants = [{ id: "g1", title: "VOCA", assistance_listings: [{ number: "16.575" }], source_url: "https://x.gov" }];
    await drainIntelQueue(asDb(s), { now, runReview: async () => demoteReview() });
    const card = s.tables.review_cards[0];
    expect(card.qa_fit_score ?? null).toBeNull();
    expect(card.fit_score).toBe(3);
    expect(s.tables.card_intel_reviews).toHaveLength(1); // still proposal-only for VOCA
  });

  it("ON + unverified on a JAG card → qa_status 'unverified', engine fit_score left as-is (fail-safe)", async () => {
    process.env.AUTO_INTEL_APPLY = "true";
    const s = seed();
    await drainIntelQueue(asDb(s), { now, runReview: async () => demoteReview({ verdict: "unverified", qa_fit_score: null, qa_factor_scores: null, unverified: true }) });
    const card = s.tables.review_cards[0];
    expect(card.qa_status).toBe("unverified");
    expect(card.qa_fit_score ?? null).toBeNull();
    expect(card.fit_score).toBe(3);
  });

  it("ON + unverified re-QA of a PREVIOUSLY-demoted JAG card → the stale applied override is CLEARED", async () => {
    process.env.AUTO_INTEL_APPLY = "true";
    const s = seed();
    // Simulate a card that a prior QA pass applied-demoted (same-score rematch cleared its verdict → re-QA).
    Object.assign(s.tables.review_cards[0], {
      qa_fit_score: 2, qa_status: "applied", qa_engine_fit_score: 3,
      qa_factor_scores: { seat_role: { rating: "weak", rationale: "stale" } }, qa_sources: [JAG_PDF],
    });
    await drainIntelQueue(asDb(s), { now, runReview: async () => demoteReview({ verdict: "unverified", qa_fit_score: null, qa_factor_scores: null, unverified: true }) });
    const card = s.tables.review_cards[0];
    expect(card.qa_status).toBe("unverified");
    // The stale demote must be gone so coalesce falls back to the engine's fit_score (3), not the old 2.
    expect(card.qa_fit_score ?? null).toBeNull();
    expect(card.qa_factor_scores ?? null).toBeNull();
    expect(card.qa_sources ?? null).toBeNull();
    expect(card.qa_engine_fit_score ?? null).toBeNull();
    expect(card.fit_score).toBe(3);
  });

  it("ON + affirm re-QA of a PREVIOUSLY-demoted JAG card → the stale applied demote is CLEARED (PR G reversal)", async () => {
    process.env.AUTO_INTEL_APPLY = "true";
    const s = seed();
    Object.assign(s.tables.review_cards[0], {
      qa_fit_score: 2, qa_status: "applied", qa_engine_fit_score: 3,
      qa_factor_scores: { seat_role: { rating: "weak", rationale: "stale" } }, qa_sources: [JAG_PDF],
    });
    await drainIntelQueue(asDb(s), { now, runReview: async () => demoteReview({ verdict: "affirm", qa_fit_score: 3, qa_factor_scores: null }) });
    const card = s.tables.review_cards[0];
    expect(card.qa_status).toBe("none"); // affirm agrees with the engine — no override in effect
    // The stale demote must be gone so coalesce falls back to the engine's 3, not the reversed-away 2.
    expect(card.qa_fit_score ?? null).toBeNull();
    expect(card.qa_factor_scores ?? null).toBeNull();
    expect(card.qa_engine_fit_score ?? null).toBeNull();
    expect(card.fit_score).toBe(3);
  });

  it("ON + a HUMAN verdict wins the upsert race (lands during runReview) → auto pass does NOT project", async () => {
    process.env.AUTO_INTEL_APPLY = "true";
    const s = seed();
    // The auto pass's own verdict is a demote, but a staffer's on-demand verdict lands mid-runReview and
    // wins the card_intel_reviews upsert (created_by = their id). The auto pass must not project its
    // discarded demote onto the card — on-demand is proposal-only, and the card must match the durable row.
    await drainIntelQueue(asDb(s), {
      now,
      runReview: async () => {
        (s.tables.card_intel_reviews ??= []).push({
          review_card_id: "card-1", intel_review: { verdict: "affirm" }, created_by: "staff-1",
        });
        return demoteReview();
      },
    });
    const card = s.tables.review_cards[0];
    expect(card.qa_fit_score ?? null).toBeNull(); // not projected — the human verdict owns the record
    expect(card.qa_status ?? null).toBeNull();
    expect(card.fit_score).toBe(3);
    // The human verdict is the one durably stored (the auto upsert no-op'd it via ignoreDuplicates).
    expect(s.tables.card_intel_reviews).toHaveLength(1);
    expect(s.tables.card_intel_reviews[0].created_by).toBe("staff-1");
  });

  it("ON + a transient apply-write error, then success → the qa_* projection lands on retry", async () => {
    process.env.AUTO_INTEL_APPLY = "true";
    const s = seed();
    s.updateFailures.review_cards = 1; // first update errors, the retry succeeds
    await drainIntelQueue(asDb(s), { now, runReview: async () => demoteReview() });
    const card = s.tables.review_cards[0];
    expect(card.qa_fit_score).toBe(2);
    expect(card.qa_status).toBe("applied");
  });

  it("ON + a PERSISTENT apply-write error → non-fatal (job done, verdict durable, engine score stands)", async () => {
    process.env.AUTO_INTEL_APPLY = "true";
    const s = seed();
    s.updateFailures.review_cards = 99; // every apply-write attempt errors
    const r = await drainIntelQueue(asDb(s), { now, runReview: async () => demoteReview() });
    const card = s.tables.review_cards[0];
    expect(r.done).toBe(1); // NOT parked as an error — the verdict is durable, the projection is cosmetic
    expect(card.qa_fit_score ?? null).toBeNull(); // never-hide: card shows the engine score, still surfaced
    expect(card.fit_score).toBe(3);
    expect(s.tables.card_intel_reviews).toHaveLength(1); // verdict durably recorded for staff regardless
  });
});
