import { describe, it, expect, afterEach } from "vitest";
import {
  closedSweepEligible,
  applyClosedSweep,
  runClosedSweep,
  closedSweepEnabled,
  REASON_UNREVIEWED,
  REASON_RELEASED,
  type SweepCardRow,
} from "./closed-sweep";

// Deterministic — NO real Supabase, NO network. A tiny in-memory fake DB implements the exact
// query chains closed-sweep.ts uses, so the guardrails are locked:
//   - STRICT `< 0`, fail-open: due-today (0) and rolling/TBD/unparseable (null) are NEVER swept
//   - the two honest reasons split on the release gate (unreleased vs released)
//   - includeReleased false-excludes / true-includes released cards
//   - only pending, non-prospect cards
//   - ZERO match_feedback writes on ANY sweep (a missed deadline is capacity, not a scorer error)
//   - the per-run cap archives the most-overdue first and reports the remainder

// ── deadline helpers (deadlineDaysLeft reads the real Date.now(), so build offsets from it) ──
const dayMs = 86_400_000;
const daysFromNow = (n: number) => new Date(Date.now() + n * dayMs).toISOString();
// Today at 00:00Z: always 0–24h in the past → deadlineDaysLeft === 0 (the due-today boundary).
const todayMidnight = () => new Date(new Date().toISOString().slice(0, 10)).toISOString();

const card = (over: Partial<SweepCardRow> & { deadline?: string | null; title?: string | null } = {}): SweepCardRow => {
  const { deadline, title, ...rest } = over;
  return {
    id: over.id ?? "card-1",
    client_id: "c1",
    decision: "pending",
    sme_released_at: null,
    card_type: "client",
    grants: { title: title ?? "A grant", submission_deadline: deadline === undefined ? daysFromNow(-5) : deadline },
    ...rest,
  };
};

// ── minimal chainable fake of the supabase subset closed-sweep.ts calls ──
type Row = Record<string, unknown>;
class Query {
  private filters: ((r: Row) => boolean)[] = [];
  private op: "select" | "update" | "insert" = "select";
  private patch: Row = {};
  private inserts: Row[] = [];
  constructor(private store: Store, private table: string) {}
  private get rows(): Row[] {
    return this.store.tables[this.table] ?? (this.store.tables[this.table] = []);
  }
  select(_cols?: string) { return this; }
  eq(col: string, val: unknown) { this.filters.push((r) => r[col] === val); return this; }
  neq(col: string, val: unknown) { this.filters.push((r) => r[col] !== val); return this; }
  in(col: string, arr: unknown[]) { this.filters.push((r) => arr.includes(r[col])); return this; }
  update(patch: Row) { this.op = "update"; this.patch = patch; return this; }
  insert(rows: Row | Row[]) { this.op = "insert"; this.inserts = Array.isArray(rows) ? rows : [rows]; return this; }
  private exec(): Promise<{ data: unknown; error: { message: string } | null }> {
    const matched = this.rows.filter((r) => this.filters.every((f) => f(r)));
    if (this.op === "select") return Promise.resolve({ data: matched.map((r) => ({ ...r })), error: null });
    if (this.op === "update") {
      this.store.updateCalls.push({ table: this.table, patch: this.patch, count: matched.length });
      for (const r of matched) Object.assign(r, this.patch);
      return Promise.resolve({ data: null, error: null });
    }
    for (const r of this.inserts) this.rows.push({ ...r });
    return Promise.resolve({ data: null, error: null });
  }
  then<T>(res: (v: { data: unknown; error: { message: string } | null }) => T) { return this.exec().then(res); }
}
class Store {
  tables: Record<string, Row[]> = {};
  updateCalls: { table: string; patch: Row; count: number }[] = [];
  from(table: string) { return new Query(this, table); }
}
const asDb = (s: Store) => s as unknown as Parameters<typeof applyClosedSweep>[0];

// ────────────────────────────── closedSweepEligible (pure) ──────────────────────────────
describe("closedSweepEligible — strict < 0, fail-open", () => {
  it("sweeps a strictly-past deadline; NEVER due-today (0) or future", () => {
    const rows = [
      card({ id: "past", deadline: daysFromNow(-5) }),
      card({ id: "today", deadline: todayMidnight() }),
      card({ id: "future", deadline: daysFromNow(5) }),
    ];
    const out = closedSweepEligible(rows, { includeReleased: false });
    expect(out.map((c) => c.cardId)).toEqual(["past"]);
    expect(out[0].daysAgo).toBeGreaterThan(0);
  });

  it("fails open on rolling / TBD / unparseable / undated / no-year deadlines (never swept)", () => {
    const rows = [
      card({ id: "rolling", deadline: "rolling" }),
      card({ id: "tbd", deadline: "TBD" }),
      card({ id: "empty", deadline: "" }),
      card({ id: "null", deadline: null }),
      card({ id: "noyear", deadline: "December 15" }),
    ];
    expect(closedSweepEligible(rows, { includeReleased: true })).toEqual([]);
  });

  it("only pending cards — a closed card already decided is history, not a miss", () => {
    const rows = [
      card({ id: "pending", decision: "pending", deadline: daysFromNow(-3) }),
      card({ id: "passed", decision: "passed", deadline: daysFromNow(-3) }),
      card({ id: "approved", decision: "approved", deadline: daysFromNow(-3) }),
    ];
    expect(closedSweepEligible(rows, { includeReleased: true }).map((c) => c.cardId)).toEqual(["pending"]);
  });

  it("excludes prospect cards", () => {
    const rows = [
      card({ id: "client", card_type: "client", deadline: daysFromNow(-3) }),
      card({ id: "prospect", card_type: "prospect", deadline: daysFromNow(-3) }),
    ];
    expect(closedSweepEligible(rows, { includeReleased: true }).map((c) => c.cardId)).toEqual(["client"]);
  });

  it("includeReleased false EXCLUDES released cards; true INCLUDES them and marks released", () => {
    const rows = [
      card({ id: "unreleased", sme_released_at: null, deadline: daysFromNow(-4) }),
      card({ id: "released", sme_released_at: "2026-08-01T00:00:00Z", deadline: daysFromNow(-4) }),
    ];
    const withoutReleased = closedSweepEligible(rows, { includeReleased: false });
    expect(withoutReleased.map((c) => c.cardId)).toEqual(["unreleased"]);
    expect(withoutReleased[0].released).toBe(false);

    const withReleased = closedSweepEligible(rows, { includeReleased: true });
    expect(withReleased.map((c) => c.cardId).sort()).toEqual(["released", "unreleased"]);
    expect(withReleased.find((c) => c.cardId === "released")!.released).toBe(true);
  });

  it("orders most-overdue first (so a capped run clears the stalest cards first)", () => {
    const rows = [
      card({ id: "recent", deadline: daysFromNow(-2) }),
      card({ id: "stale", deadline: daysFromNow(-30) }),
      card({ id: "mid", deadline: daysFromNow(-10) }),
    ];
    expect(closedSweepEligible(rows, { includeReleased: true }).map((c) => c.cardId)).toEqual(["stale", "mid", "recent"]);
  });
});

// ────────────────────────────── applyClosedSweep (fake DB) ──────────────────────────────
describe("applyClosedSweep — two honest reasons, NO calibration", () => {
  it("writes decision='passed' with the right reason per group and passes decidedBy + actor 'staff'", async () => {
    const s = new Store();
    s.tables.review_cards = [
      { id: "u1", decision: "pending" },
      { id: "r1", decision: "pending" },
    ];
    const archived = await applyClosedSweep(
      asDb(s),
      [
        { cardId: "u1", clientId: "c1", released: false, daysAgo: 4, grantTitle: "U" },
        { cardId: "r1", clientId: "c1", released: true, daysAgo: 9, grantTitle: "R" },
      ],
      { decidedBy: "staff-7" },
    );
    expect(archived).toBe(2);
    const u1 = s.tables.review_cards.find((r) => r.id === "u1")!;
    const r1 = s.tables.review_cards.find((r) => r.id === "r1")!;
    expect(u1).toMatchObject({ decision: "passed", decision_reason: REASON_UNREVIEWED, decided_by: "staff-7", decided_by_actor: "staff" });
    expect(r1).toMatchObject({ decision: "passed", decision_reason: REASON_RELEASED, decided_by: "staff-7", decided_by_actor: "staff" });
    // At most two statements — one per non-empty reason group.
    expect(s.updateCalls).toHaveLength(2);
  });

  it("writes ZERO match_feedback rows for EITHER group (a missed deadline is capacity, not a scorer error)", async () => {
    const s = new Store();
    s.tables.review_cards = [
      { id: "u1", decision: "pending" },
      { id: "r1", decision: "pending" },
    ];
    await applyClosedSweep(
      asDb(s),
      [
        { cardId: "u1", clientId: "c1", released: false, daysAgo: 4, grantTitle: "U" },
        { cardId: "r1", clientId: "c1", released: true, daysAgo: 9, grantTitle: "R" },
      ],
      { decidedBy: null },
    );
    expect(s.tables.match_feedback).toBeUndefined();
    // And every write went to review_cards only.
    expect(s.updateCalls.every((c) => c.table === "review_cards")).toBe(true);
  });

  it("emits a single statement when only one group is present", async () => {
    const s = new Store();
    s.tables.review_cards = [{ id: "u1", decision: "pending" }];
    await applyClosedSweep(asDb(s), [{ cardId: "u1", clientId: "c1", released: false, daysAgo: 4, grantTitle: "U" }], { decidedBy: null });
    expect(s.updateCalls).toHaveLength(1);
  });
});

// ────────────────────────────── runClosedSweep (all-clients driver, fake DB) ──────────────────────────────
function seed(s: Store) {
  s.tables.review_cards = [
    { id: "stale", client_id: "c1", decision: "pending", sme_released_at: null, card_type: "client", grants: { title: "Stale", submission_deadline: daysFromNow(-30) } },
    { id: "mid", client_id: "c1", decision: "pending", sme_released_at: null, card_type: "client", grants: { title: "Mid", submission_deadline: daysFromNow(-10) } },
    { id: "released", client_id: "c2", decision: "pending", sme_released_at: "2026-08-01T00:00:00Z", card_type: "client", grants: { title: "Rel", submission_deadline: daysFromNow(-3) } },
    { id: "live", client_id: "c1", decision: "pending", sme_released_at: null, card_type: "client", grants: { title: "Live", submission_deadline: daysFromNow(20) } },
    { id: "prospect", client_id: "c3", decision: "pending", sme_released_at: null, card_type: "prospect", grants: { title: "Pros", submission_deadline: daysFromNow(-9) } },
  ];
}

describe("runClosedSweep — dry-run vs apply, cap, split", () => {
  it("dry-run writes NOTHING and reports the split (released counted separately)", async () => {
    const s = new Store();
    seed(s);
    const res = await runClosedSweep(asDb(s), { includeReleased: true, apply: false });
    expect(res.archived).toBe(0);
    expect(res.eligible).toBe(3); // stale, mid, released (live=future, prospect=excluded)
    expect(res.byReason).toEqual({ closedBeforeReview: 2, deadlinePassedAfterRelease: 1 });
    expect(res.remaining).toBe(3);
    expect(s.updateCalls).toHaveLength(0);
    expect(s.tables.review_cards.every((r) => r.decision === "pending")).toBe(true);
    expect(s.tables.match_feedback).toBeUndefined();
    // Sample leads with the released (sensitive) card.
    expect(res.sample[0].released).toBe(true);
  });

  it("apply archives every eligible closed card, leaving live + prospect untouched, no match_feedback", async () => {
    const s = new Store();
    seed(s);
    const res = await runClosedSweep(asDb(s), { includeReleased: true, apply: true, decidedBy: null });
    expect(res.archived).toBe(3);
    expect(res.remaining).toBe(0);
    const byId = Object.fromEntries(s.tables.review_cards.map((r) => [r.id, r]));
    expect(byId.stale.decision).toBe("passed");
    expect(byId.mid.decision).toBe("passed");
    expect(byId.released).toMatchObject({ decision: "passed", decision_reason: REASON_RELEASED });
    expect(byId.live.decision).toBe("pending"); // future deadline — never swept
    expect(byId.prospect.decision).toBe("pending"); // prospect — excluded
    expect(s.tables.match_feedback).toBeUndefined();
  });

  it("caps the WRITE at limit, most-overdue first, and reports the remainder", async () => {
    const s = new Store();
    seed(s);
    const res = await runClosedSweep(asDb(s), { includeReleased: true, apply: true, limit: 1, decidedBy: null });
    expect(res.archived).toBe(1);
    expect(res.remaining).toBe(2);
    const byId = Object.fromEntries(s.tables.review_cards.map((r) => [r.id, r]));
    expect(byId.stale.decision).toBe("passed"); // the -30d card, cleared first
    expect(byId.mid.decision).toBe("pending");
    expect(byId.released.decision).toBe("pending");
  });

  it("includeReleased false leaves released cards alone", async () => {
    const s = new Store();
    seed(s);
    const res = await runClosedSweep(asDb(s), { includeReleased: false, apply: true, decidedBy: null });
    expect(res.archived).toBe(2); // stale + mid only
    expect(s.tables.review_cards.find((r) => r.id === "released")!.decision).toBe("pending");
  });
});

// ────────────────────────────── flag ──────────────────────────────
describe("closedSweepEnabled — default OFF", () => {
  const prev = process.env.CLOSED_SWEEP_ENABLED;
  afterEach(() => {
    if (prev === undefined) delete process.env.CLOSED_SWEEP_ENABLED;
    else process.env.CLOSED_SWEEP_ENABLED = prev;
  });
  it("off unless exactly 'true'", () => {
    delete process.env.CLOSED_SWEEP_ENABLED;
    expect(closedSweepEnabled()).toBe(false);
    process.env.CLOSED_SWEEP_ENABLED = "false";
    expect(closedSweepEnabled()).toBe(false);
    process.env.CLOSED_SWEEP_ENABLED = "1";
    expect(closedSweepEnabled()).toBe(false);
    process.env.CLOSED_SWEEP_ENABLED = "true";
    expect(closedSweepEnabled()).toBe(true);
  });
});
