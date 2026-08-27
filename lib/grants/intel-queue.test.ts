import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { pollAndEnqueue, drainIntelQueue, runAutoIntel, INTEL_MAX_ATTEMPTS } from "./intel-queue";
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
  private single = false;
  private selectAfterWrite = false;
  private orderBy: { col: string; asc: boolean } | null = null;
  private lim: number | null = null;
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
  returns() { return this; }
  update(patch: Row) { this.op = "update"; this.patch = patch; return this; }
  upsert(rows: Row | Row[], opts?: { onConflict?: string }) { this.op = "upsert"; this.inserts = Array.isArray(rows) ? rows : [rows]; this.onConflict = (opts?.onConflict ?? "").split(",").map((s) => s.trim()).filter(Boolean); return this; }
  insert(rows: Row | Row[]) { this.op = "insert"; this.inserts = Array.isArray(rows) ? rows : [rows]; return this; }
  maybeSingle() { this.single = true; return this.exec(); }
  private matched(): Row[] {
    let out = this.rows.filter((r) => this.filters.every((f) => f(r)));
    if (this.orderBy) { const { col, asc } = this.orderBy; out = [...out].sort((a, b) => (String(a[col]) < String(b[col]) ? -1 : 1) * (asc ? 1 : -1)); }
    if (this.lim != null) out = out.slice(0, this.lim);
    return out;
  }
  private exec(): Promise<{ data: unknown; error: null }> {
    // Real supabase returns DETACHED rows: a later .update(...).eq("id", …) mutates the DB, never the JS
    // object an earlier SELECT handed you. The fake must copy on read too, else a claimed row's in-memory
    // `attempts` would appear pre-incremented and mask the retry-cap off-by-one this suite locks.
    if (this.op === "select") {
      const m = this.matched().map((r) => ({ ...r }));
      return Promise.resolve({ data: this.single ? (m[0] ?? null) : m, error: null });
    }
    if (this.op === "update") {
      const m = this.matched();
      for (const r of m) Object.assign(r, this.patch);
      return Promise.resolve({ data: this.selectAfterWrite ? m.map((r) => ({ ...r })) : null, error: null });
    }
    if (this.op === "insert") { for (const r of this.inserts) this.rows.push({ ...r }); return Promise.resolve({ data: null, error: null }); }
    // upsert
    for (const nr of this.inserts) {
      const existing = this.onConflict.length ? this.rows.find((r) => this.onConflict.every((k) => r[k] === nr[k])) : undefined;
      if (existing) Object.assign(existing, nr);
      else this.rows.push({ ...nr });
    }
    return Promise.resolve({ data: null, error: null });
  }
  then<T>(res: (v: { data: unknown; error: null }) => T) { return this.exec().then(res); }
}
class Store {
  tables: Record<string, Row[]> = {};
  from(table: string) { return new Query(this, table); }
}
const db = () => new Store();
// The fake implements only the subset of the client the queue module uses; cast to the DB param type.
const asDb = (s: Store) => s as unknown as Parameters<typeof pollAndEnqueue>[0];

const NOW = Date.parse("2026-08-27T12:00:00.000Z");
const now = () => NOW;

const okReview = (verdict: IntelReview["verdict"] = "affirm", searches = 0): IntelReview => ({
  verdict, engine_fit_score: 3, qa_fit_score: verdict === "affirm" ? 3 : null, summary: "s", evidence: [], fetched: [],
  searched: Array(searches).fill("q"), unverified: false, model: "claude-opus-5", reviewed_by: null, reviewed_at: "T",
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

  it("marks a job done+skipped (no model call) when the card is no longer pending", async () => {
    s.tables.review_cards = [pendingCard({ decision: "approved" })]; // decided since enqueue
    let called = false;
    const r = await drainIntelQueue(asDb(s), { now, runReview: async () => { called = true; return okReview(); } });
    expect(called).toBe(false);
    expect(r.skipped).toBe(1);
    expect(s.tables.intel_review_queue[0].status).toBe("done");
    expect(s.tables.card_intel_reviews ?? []).toHaveLength(0);
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
