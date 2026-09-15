import { describe, it, expect, afterEach, vi } from "vitest";
import {
  reduceAwardHistory,
  isProfileSparse,
  buildFitContext,
  buildFitPatch,
  fitNarrativeStale,
  displayedFitOf,
  generateFitNarrative,
  runFitAnalysis,
  runFitAnalysisForCard,
  type FitCard,
  type FitGrant,
  type FitPollRow,
} from "./fit-analysis";
import type { ProgramAwardSummary } from "./program-awards";
import type { Client } from "@/types/database";

// Deterministic — NO model, NO network, NO real Supabase. The model call (`generate`) and clock are injected;
// a tiny in-memory fake DB implements the query chains fit-analysis.ts uses, so the invariants lock without
// a live model:
//   - the state-presence-ONLY award reducer (names never surface; zero in-state → silent)
//   - the profile-INCLUSIVE context (the #140-exempt unlock) + the sparse-data path
//   - buildFitPatch writes ONLY fit_narrative* columns (the non-scorer guarantee)
//   - the freshness + direction gate (go/marginal only; snapshot must match the displayed score)
//   - the drain: flag gate, generate + write, pause skip, closed skip, the daily cost cap

// ── A minimal chainable fake of the subset of supabase-js the module calls ──────────────────────────
type Row = Record<string, unknown>;
class Q {
  private filters: ((r: Row) => boolean)[] = [];
  private op: "select" | "update" = "select";
  private patch: Row = {};
  private single = false;
  private countMode = false;
  private orderBy: { col: string; asc: boolean } | null = null;
  private rangeFromTo: { from: number; to: number } | null = null;
  private lim: number | null = null;
  constructor(private store: Store, private table: string) {}
  private get rows(): Row[] {
    return this.store.tables[this.table] ?? (this.store.tables[this.table] = []);
  }
  select(_c?: string, opts?: { count?: string; head?: boolean }) {
    if (opts?.count) this.countMode = true;
    return this;
  }
  eq(c: string, v: unknown) { this.filters.push((r) => r[c] === v); return this; }
  is(c: string, v: unknown) { this.filters.push((r) => (r[c] ?? null) === v); return this; }
  not(c: string, _o: string, v: unknown) { this.filters.push((r) => (r[c] ?? null) !== v); return this; }
  in(c: string, a: unknown[]) { this.filters.push((r) => a.includes(r[c])); return this; }
  gte(c: string, v: unknown) { this.filters.push((r) => String(r[c]) >= String(v)); return this; }
  order(c: string, o?: { ascending?: boolean }) { this.orderBy = { col: c, asc: o?.ascending !== false }; return this; }
  range(f: number, t: number) { this.rangeFromTo = { from: f, to: t }; return this; }
  limit(n: number) { this.lim = n; return this; }
  returns() { return this; }
  update(p: Row) { this.op = "update"; this.patch = p; return this; }
  maybeSingle() { this.single = true; return this.exec(); }
  private matched(): Row[] {
    let out = this.rows.filter((r) => this.filters.every((f) => f(r)));
    if (this.orderBy) {
      const { col, asc } = this.orderBy;
      out = [...out].sort((a, b) => (String(a[col] ?? "") < String(b[col] ?? "") ? -1 : 1) * (asc ? 1 : -1));
    }
    if (this.rangeFromTo) out = out.slice(this.rangeFromTo.from, this.rangeFromTo.to + 1);
    else if (this.lim != null) out = out.slice(0, this.lim);
    return out;
  }
  private exec(): Promise<{ data: unknown; error: null; count?: number }> {
    if (this.op === "update") {
      const m = this.rows.filter((r) => this.filters.every((f) => f(r)));
      for (const r of m) Object.assign(r, this.patch);
      return Promise.resolve({ data: null, error: null });
    }
    const m = this.matched().map((r) => ({ ...r }));
    if (this.countMode) return Promise.resolve({ data: null, error: null, count: m.length });
    return Promise.resolve({ data: this.single ? (m[0] ?? null) : m, error: null });
  }
  then<T>(res: (v: { data: unknown; error: null; count?: number }) => T) { return this.exec().then(res); }
}
class Store {
  tables: Record<string, Row[]> = {};
  from(t: string) { return new Q(this, t); }
}
const asDb = (s: Store) => s as unknown as Parameters<typeof runFitAnalysis>[0];

const NOW = Date.parse("2026-09-15T12:00:00.000Z");
const TODAY_ISO = new Date(NOW).toISOString();
const FUTURE = "2027-01-15"; // a future deadline (not closed)

const client = (over: Partial<Client> = {}): Client =>
  ({
    id: "c1",
    name: "Northwest Arkansas Community College",
    org_type: "higher_education",
    location_city: "Bentonville",
    location_state: "AR",
    service_area: ["Benton County", "Washington County"],
    primary_funding_needs: ["workforce development"],
    match_active: true,
    client_profile: {
      summary: "A two-year community college.",
      mission: "Expand workforce and career pathways across Northwest Arkansas.",
      funding_priorities: ["workforce development", "student support"],
      core_capabilities: ["career and technical education", "adult education"],
    },
    ...over,
  }) as unknown as Client;

const grant = (over: Partial<FitGrant & { program_award_summary: ProgramAwardSummary | null }> = {}) =>
  ({
    title: "Strengthening Community College Workforce Pipelines",
    funder: "U.S. Department of Labor",
    description_brief: "Funds community and technical colleges to build employer-aligned workforce training programs.",
    description: null,
    eligible_entity_types: ["higher_education", "community_college"],
    program_type: "discretionary",
    geographic_eligibility: "National",
    submission_deadline: FUTURE,
    program_award_summary: null,
    ...over,
  }) as FitGrant & { program_award_summary: ProgramAwardSummary | null };

const card = (over: Partial<FitCard> = {}): FitCard => ({
  fit_score: 3,
  proposed_role: "Prime",
  recommended_prime: null,
  why_this_org: ["Directly eligible as a community college with an active CTE program."],
  reasoning_context: { role_assignment_logic: "Eligible to prime as an IHE running workforce training." },
  ...over,
});

const summary = (byState: { state: string; name: string; amount: number; count: number }[], totalAmount = 0, totalAwardsFetched = 0): ProgramAwardSummary =>
  ({
    cfdas: ["17.999"],
    programTitles: ["Workforce Pipelines"],
    scope: "recipient_location",
    timePeriod: { start: "2016-01-01", end: "2026-01-01" },
    totalAmount,
    totalAwardsFetched,
    awardsTruncated: false,
    byState,
    topAwards: byState.map((s) => ({ awardId: "x", recipient: `${s.name} Winner Org`, amount: s.amount, agency: "DOL", startDate: "2024", state: s.state })),
  }) as ProgramAwardSummary;

afterEach(() => vi.unstubAllEnvs());

// ── reduceAwardHistory: STATE-PRESENCE ONLY (the compliance-critical guardrail) ─────────────────────
describe("reduceAwardHistory — state-presence only, names withheld", () => {
  it("null / empty summary → both null", () => {
    expect(reduceAwardHistory(null, "AR")).toEqual({ inState: null, national: null });
    expect(reduceAwardHistory(undefined, "AR")).toEqual({ inState: null, national: null });
  });

  it("positive in-state presence → inState + national totals, no recipient names in the shape", () => {
    const s = summary([{ state: "AR", name: "Arkansas", amount: 4_200_000, count: 6 }, { state: "TX", name: "Texas", amount: 9_000_000, count: 12 }], 30_000_000, 40);
    const r = reduceAwardHistory(s, "AR");
    expect(r.inState).toEqual({ state: "AR", amount: 4_200_000, count: 6 });
    expect(r.national).toEqual({ amount: 30_000_000, count: 40 });
    // The reduced shape carries NO recipient names — structurally impossible to construct a by-type claim.
    expect(JSON.stringify(r)).not.toMatch(/Winner Org|Arkansas|Texas/);
  });

  it("zero / absent in-state → both null (silent on zero in-state — no absence statement)", () => {
    const s = summary([{ state: "TX", name: "Texas", amount: 9_000_000, count: 12 }], 30_000_000, 40);
    expect(reduceAwardHistory(s, "AR")).toEqual({ inState: null, national: null });
    const zero = summary([{ state: "AR", name: "Arkansas", amount: 0, count: 0 }], 30_000_000, 40);
    expect(reduceAwardHistory(zero, "AR")).toEqual({ inState: null, national: null });
  });

  it("national never rides without a positive in-state signal", () => {
    const s = summary([{ state: "OK", name: "Oklahoma", amount: 1_000_000, count: 2 }], 30_000_000, 40);
    expect(reduceAwardHistory(s, null).national).toBeNull();
  });
});

// ── isProfileSparse + buildFitContext ────────────────────────────────────────────────────────────────
describe("isProfileSparse", () => {
  it("true only when mission, priorities, capabilities AND funding needs are all thin", () => {
    expect(isProfileSparse(client())).toBe(false);
    expect(isProfileSparse(client({ client_profile: null, primary_funding_needs: [] }))).toBe(true);
    // A real stated need with no distilled profile is NOT fully sparse.
    expect(isProfileSparse(client({ client_profile: null, primary_funding_needs: ["housing"] }))).toBe(false);
  });
});

describe("buildFitContext — profile-inclusive, band word, award state-line", () => {
  it("includes the client mission / priorities / capabilities (the profile unlock) and the band word", () => {
    const ctx = buildFitContext({ grant: grant(), client: client(), card: card(), band: "strong", award: { inState: null, national: null } });
    expect(ctx).toContain("STRONG MATCH");
    expect(ctx).toContain("Expand workforce and career pathways"); // mission
    expect(ctx).toContain("student support"); // a funding priority
    expect(ctx).toContain("career and technical education"); // a capability
    expect(ctx).toContain("What it funds"); // the funded-purpose axis
    expect(ctx).toContain("Recommended role: Prime");
  });

  it("award line states in-state presence when present, and 'do not mention awards' when absent", () => {
    const withAward = buildFitContext({
      grant: grant(),
      client: client(),
      card: card(),
      band: "strong",
      award: { inState: { state: "AR", amount: 4_200_000, count: 6 }, national: { amount: 30_000_000, count: 40 } },
    });
    expect(withAward).toContain("In AR: $4.2M across 6 awards");
    expect(withAward).not.toMatch(/Winner Org/); // never a recipient name

    const noAward = buildFitContext({ grant: grant(), client: client(), card: card(), band: "conditional", award: { inState: null, national: null } });
    expect(noAward).toContain("do not mention awards");
    expect(noAward).toContain("CONDITIONAL MATCH");
  });

  it("sparse client renders explicit '(not on file)' so the model sees the absence", () => {
    const ctx = buildFitContext({
      grant: grant(),
      client: client({ client_profile: null, primary_funding_needs: [], service_area: [] }),
      card: card(),
      band: "conditional",
      award: { inState: null, national: null },
    });
    expect(ctx).toContain("Mission: (not on file)");
    expect(ctx).toContain("Funding priorities: (not on file)");
    expect(ctx).toContain("Capabilities: (not on file)");
  });
});

// ── buildFitPatch: writes ONLY fit_narrative* columns (the non-scorer lock) ──────────────────────────
describe("buildFitPatch — writes ONLY fit_narrative* columns", () => {
  it("real narrative → text + snapshot + model + stamp; EVERY key is fit_narrative-prefixed", () => {
    const p = buildFitPatch("A strong workforce fit for this community college.", 3, "claude-opus-5", TODAY_ISO);
    expect(p).toEqual({
      fit_narrative: "A strong workforce fit for this community college.",
      fit_narrative_fit_score: 3,
      fit_narrative_model: "claude-opus-5",
      fit_narrative_at: TODAY_ISO,
      // A machine (re)generation always CLEARS the human-edit lock (migration 0100) — the on-demand
      // regenerate is the "revert to auto" that flips a staffer's true back to false.
      fit_narrative_edited: false,
    });
    for (const k of Object.keys(p)) expect(k.startsWith("fit_narrative")).toBe(true);
  });

  it("null narrative → clears text + snapshot but STILL stamps (so the poller doesn't loop on it)", () => {
    const p = buildFitPatch(null, 2, "claude-opus-5", TODAY_ISO);
    expect(p.fit_narrative).toBeNull();
    expect(p.fit_narrative_fit_score).toBeNull();
    expect(p.fit_narrative_at).toBe(TODAY_ISO);
    expect(p.fit_narrative_edited).toBe(false); // machine write clears the lock
    for (const k of Object.keys(p)) expect(k.startsWith("fit_narrative")).toBe(true);
  });
});

// ── freshness + direction gate ───────────────────────────────────────────────────────────────────────
describe("displayedFitOf / fitNarrativeStale — go/marginal only, snapshot must match", () => {
  const pollRow = (over: Partial<FitPollRow> = {}): FitPollRow =>
    ({ id: "r1", grant_id: "g1", client_id: "c1", fit_score: 3, factor_scores: null, proposed_role: "Prime", recommended_prime: null, why_this_org: null, reasoning_context: null, ...over }) as FitPollRow;

  it("a no-go (displayed 1) is never eligible — qa_narrative owns it", () => {
    expect(displayedFitOf(pollRow({ fit_score: 1 }))).toBe(1);
    expect(fitNarrativeStale(pollRow({ fit_score: 1, fit_narrative: null }))).toBe(false);
  });

  it("a fresh go (text + snapshot === displayed 3) is NOT stale", () => {
    expect(fitNarrativeStale(pollRow({ fit_score: 3, fit_narrative: "fresh", fit_narrative_fit_score: 3 }))).toBe(false);
  });

  it("a go with no narrative yet IS stale (needs generation)", () => {
    expect(fitNarrativeStale(pollRow({ fit_score: 3, fit_narrative: null }))).toBe(true);
  });

  it("a snapshot that no longer matches the displayed score IS stale", () => {
    expect(fitNarrativeStale(pollRow({ fit_score: 2, fit_narrative: "written for a 3", fit_narrative_fit_score: 3 }))).toBe(true);
  });

  it("a card with a fresh APPLIED QA demote is NOT eligible — qa_narrative owns it (#564)", () => {
    // engine 3, QA applied a demote to 2. displayed is 2, but the grounded qa_narrative owns the card, so the
    // fit-analysis pass must NOT generate an (ungrounded) affirmative paragraph for it.
    const row = pollRow({ fit_score: 3, qa_status: "applied", qa_fit_score: 2, qa_engine_fit_score: 3, fit_narrative: null });
    expect(displayedFitOf(row)).toBe(2);
    expect(fitNarrativeStale(row)).toBe(false);
  });

  it("an AFFIRM/flag clearing verdict (qa_status 'none') does NOT block eligibility — no applied demote", () => {
    const row = pollRow({ fit_score: 3, qa_status: "none", qa_fit_score: null, qa_engine_fit_score: 3, fit_narrative: null });
    expect(fitNarrativeStale(row)).toBe(true);
  });

  // ── human-edit lock (migration 0100): the drain never regenerates an edited card ──
  it("an EDITED card is never stale — even with a mismatched snapshot (the drain would otherwise regenerate)", () => {
    // Snapshot 3 ≠ displayed 2 would normally be stale (regenerate); the lock overrides that so the drain
    // never clobbers the staffer's edit.
    const row = pollRow({ fit_score: 2, fit_narrative: "the staffer's edit", fit_narrative_fit_score: 3, fit_narrative_edited: true });
    expect(fitNarrativeStale(row)).toBe(false);
  });

  it("an EDITED card with NO text is still not stale — the lock wins even over a missing narrative", () => {
    const row = pollRow({ fit_score: 3, fit_narrative: null, fit_narrative_edited: true });
    expect(fitNarrativeStale(row)).toBe(false);
  });
});

// ── generateFitNarrative: the client-safety guard ────────────────────────────────────────────────────
describe("generateFitNarrative — narrativeGuard + seat-code strip", () => {
  it("nulls a leaked internal-framing narrative (falls back to the engine paragraph)", async () => {
    const leaked = async () => "The engine scored this a 3, so position this to the client as a workforce win.";
    expect(await generateFitNarrative(card(), grant(), client(), "strong", { generate: leaked })).toBeNull();
  });

  it("strips a seat code and returns the clean paragraph", async () => {
    const withCode = async () => "Fills the lead applicant seat (P0) as an eligible community college.";
    const out = await generateFitNarrative(card(), grant(), client(), "strong", { generate: withCode });
    expect(out).toBe("Fills the lead applicant seat as an eligible community college.");
    expect(out).not.toMatch(/[SP]\d/);
  });

  it("passes a clean narrative through unchanged", async () => {
    const clean = async () => "An eligible community college whose workforce mission maps onto what this program funds.";
    expect(await generateFitNarrative(card(), grant(), client(), "strong", { generate: clean })).toBe(
      "An eligible community college whose workforce mission maps onto what this program funds.",
    );
  });
});

// ── runFitAnalysis: the drain ────────────────────────────────────────────────────────────────────────
describe("runFitAnalysis — flag gate, generate + write, skips, cost cap", () => {
  const seedCard = (store: Store, over: Row = {}) => {
    store.tables.review_cards = store.tables.review_cards ?? [];
    store.tables.review_cards.push({
      id: "card-1", grant_id: "g1", client_id: "c1", fit_score: 3, factor_scores: null,
      proposed_role: "Prime", recommended_prime: null, why_this_org: ["eligible"], reasoning_context: {},
      qa_fit_score: null, qa_status: null, qa_engine_fit_score: null,
      fit_narrative: null, fit_narrative_fit_score: null, fit_narrative_at: null,
      // Mirrors the DB default (migration 0100: NOT NULL DEFAULT false) so the poll's
      // .eq("fit_narrative_edited", false) filter matches an unedited seeded card.
      fit_narrative_edited: false,
      decision: "pending", sme_released_at: null, card_type: "client", created_at: "2026-09-01T00:00:00Z",
      ...over,
    });
  };
  const seedGrantClient = (store: Store, gOver: Partial<FitGrant & { program_award_summary: ProgramAwardSummary | null }> = {}, cOver: Partial<Client> = {}) => {
    store.tables.grants = [{ id: "g1", ...grant(gOver) }];
    store.tables.clients = store.tables.clients ?? [];
    store.tables.clients.push(client(cOver) as unknown as Row); // client() already carries id: "c1"
  };
  const gen = async () => "An eligible community college whose workforce mission maps onto what this funds.";

  it("flag OFF → no-op, no write (byte-identical)", async () => {
    vi.stubEnv("FIT_ANALYSIS_ENABLED", "false");
    const store = new Store();
    seedCard(store);
    seedGrantClient(store);
    const r = await runFitAnalysis(asDb(store), { now: () => NOW, generate: gen });
    expect(r).toEqual({ scanned: 0, eligible: 0, generated: 0, cleared: 0, skippedClosed: 0, failed: 0, capReached: false, spentTodayUsd: 0 });
    expect(store.tables.review_cards[0].fit_narrative).toBeNull();
  });

  it("flag ON → generates for a stale go card and writes ONLY the fit_narrative* columns", async () => {
    vi.stubEnv("FIT_ANALYSIS_ENABLED", "true");
    const store = new Store();
    seedCard(store);
    seedGrantClient(store);
    const r = await runFitAnalysis(asDb(store), { now: () => NOW, generate: gen });
    expect(r.generated).toBe(1);
    const row = store.tables.review_cards[0];
    expect(row.fit_narrative).toBe("An eligible community college whose workforce mission maps onto what this funds.");
    expect(row.fit_narrative_fit_score).toBe(3);
    expect(row.fit_narrative_model).toBe("claude-opus-5");
    // The engine's own columns are UNTOUCHED (non-scorer).
    expect(row.fit_score).toBe(3);
    expect(row.decision).toBe("pending");
  });

  it("skips a no-go (fit 1) card — never generates an affirmative narrative for it", async () => {
    vi.stubEnv("FIT_ANALYSIS_ENABLED", "true");
    const store = new Store();
    seedCard(store, { fit_score: 1 });
    seedGrantClient(store);
    const r = await runFitAnalysis(asDb(store), { now: () => NOW, generate: gen });
    expect(r.eligible).toBe(0);
    expect(store.tables.review_cards[0].fit_narrative).toBeNull();
  });

  it("skips a paused client's card (match_active=false) — no Opus spend", async () => {
    vi.stubEnv("FIT_ANALYSIS_ENABLED", "true");
    const store = new Store();
    seedCard(store);
    seedGrantClient(store, {}, { match_active: false });
    const r = await runFitAnalysis(asDb(store), { now: () => NOW, generate: gen });
    expect(r.eligible).toBe(0);
    expect(store.tables.review_cards[0].fit_narrative).toBeNull();
  });

  it("skips a closed (deadline passed) card without spending", async () => {
    vi.stubEnv("FIT_ANALYSIS_ENABLED", "true");
    const store = new Store();
    seedCard(store);
    seedGrantClient(store, { submission_deadline: "2020-01-01" });
    const r = await runFitAnalysis(asDb(store), { now: () => NOW, generate: gen });
    expect(r.skippedClosed).toBe(1);
    expect(r.generated).toBe(0);
    expect(store.tables.review_cards[0].fit_narrative).toBeNull();
  });

  it("skips an EDITED card — the drain never regenerates a staffer's narrative (migration 0100)", async () => {
    vi.stubEnv("FIT_ANALYSIS_ENABLED", "true");
    const store = new Store();
    // A mismatched snapshot (2 vs displayed 3) would normally be stale → regenerated; the lock stops it.
    seedCard(store, { fit_narrative: "the staffer's edit", fit_narrative_fit_score: 2, fit_narrative_edited: true });
    seedGrantClient(store);
    const r = await runFitAnalysis(asDb(store), { now: () => NOW, generate: gen });
    expect(r.eligible).toBe(0);
    expect(r.generated).toBe(0);
    expect(store.tables.review_cards[0].fit_narrative).toBe("the staffer's edit"); // untouched
  });

  it("daily cost cap stops the pass before any generation", async () => {
    vi.stubEnv("FIT_ANALYSIS_ENABLED", "true");
    const store = new Store();
    seedCard(store);
    seedGrantClient(store);
    // A prior card already generated today so today's spend already covers the cap.
    store.tables.review_cards.push({ id: "spent-1", decision: "passed", card_type: "client", fit_narrative_at: TODAY_ISO });
    const r = await runFitAnalysis(asDb(store), { now: () => NOW, generate: gen, estCostUsd: 0.1, dailyCapUsd: 0.1 });
    expect(r.capReached).toBe(true);
    expect(r.generated).toBe(0);
  });

  it("skips a card with a fresh applied QA demote — qa_narrative owns it, no generation (#564)", async () => {
    vi.stubEnv("FIT_ANALYSIS_ENABLED", "true");
    const store = new Store();
    seedCard(store, { qa_status: "applied", qa_fit_score: 2, qa_engine_fit_score: 3 }); // engine 3, QA demoted to 2
    seedGrantClient(store);
    const r = await runFitAnalysis(asDb(store), { now: () => NOW, generate: gen });
    expect(r.eligible).toBe(0);
    expect(store.tables.review_cards[0].fit_narrative).toBeNull();
  });
});

// ── runFitAnalysisForCard: the on-demand admin path ──────────────────────────────────────────────────
describe("runFitAnalysisForCard — single card, ignores the daily cap", () => {
  const seedOne = (store: Store, over: Row) => {
    store.tables.review_cards = [{
      id: "card-x", grant_id: "g1", client_id: "c1", fit_score: 3, factor_scores: null,
      proposed_role: "Prime", recommended_prime: null, why_this_org: null, reasoning_context: {},
      qa_fit_score: null, qa_status: null, qa_engine_fit_score: null, fit_narrative: null, fit_narrative_fit_score: null, fit_narrative_at: null,
      decision: "pending", sme_released_at: null, card_type: "client", ...over,
    }];
    store.tables.grants = [{ id: "g1", ...grant() }];
    store.tables.clients = [client() as unknown as Row];
  };

  it("skips a RELEASED card — never rewrites a client-visible narrative (#564)", async () => {
    const store = new Store();
    seedOne(store, { sme_released_at: "2026-09-10T00:00:00Z" });
    const res = await runFitAnalysisForCard(asDb(store), "card-x", { now: () => NOW, generate: async () => "must not generate" });
    expect(res.outcome).toBe("skipped");
    expect(store.tables.review_cards[0].fit_narrative).toBeNull();
  });

  it("skips a DECIDED (passed) card (#564)", async () => {
    const store = new Store();
    seedOne(store, { decision: "passed" });
    const res = await runFitAnalysisForCard(asDb(store), "card-x", { now: () => NOW, generate: async () => "must not generate" });
    expect(res.outcome).toBe("skipped");
  });

  it("does NOT write if the card is RELEASED during generation — write-time race (#565)", async () => {
    const store = new Store();
    seedOne(store, {}); // pending + unreleased at read time → passes the read guard
    // Simulate a staffer releasing the card DURING the (slow) Opus call: the generate callback mutates
    // sme_released_at before returning, so the atomic write guard must skip the write.
    const releasingGenerate = async () => {
      store.tables.review_cards[0].sme_released_at = "2026-09-11T00:00:00Z";
      return "a narrative that must NOT land on the now-released card";
    };
    await runFitAnalysisForCard(asDb(store), "card-x", { now: () => NOW, generate: releasingGenerate });
    expect(store.tables.review_cards[0].fit_narrative).toBeNull();
  });

  it("does NOT write if the card is DECIDED during generation — write-time race (#565)", async () => {
    const store = new Store();
    seedOne(store, {});
    const decidingGenerate = async () => {
      store.tables.review_cards[0].decision = "passed";
      return "a narrative that must NOT land on the now-decided card";
    };
    await runFitAnalysisForCard(asDb(store), "card-x", { now: () => NOW, generate: decidingGenerate });
    expect(store.tables.review_cards[0].fit_narrative).toBeNull();
  });

  it("generates for one go/marginal card and returns the stored narrative", async () => {
    const store = new Store();
    store.tables.review_cards = [{
      id: "card-9", grant_id: "g1", client_id: "c1", fit_score: 2, factor_scores: null,
      proposed_role: "Sub", recommended_prime: "county government", why_this_org: ["fits a supporting seat"], reasoning_context: {},
      qa_fit_score: null, qa_status: null, qa_engine_fit_score: null, fit_narrative: null, fit_narrative_fit_score: null, fit_narrative_at: null,
      decision: "pending", sme_released_at: null, card_type: "client",
    }];
    store.tables.grants = [{ id: "g1", ...grant() }];
    store.tables.clients = [client() as unknown as Row]; // client() already carries id: "c1"
    const res = await runFitAnalysisForCard(asDb(store), "card-9", { now: () => NOW, generate: async () => "A conditional fit — genuinely in the lane, but lock a prime first." });
    expect(res.outcome).toBe("generated");
    expect(res.narrative).toBe("A conditional fit — genuinely in the lane, but lock a prime first.");
    expect(store.tables.review_cards[0].fit_narrative_fit_score).toBe(2);
  });
});
