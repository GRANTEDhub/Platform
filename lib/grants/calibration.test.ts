import { describe, it, expect } from "vitest";
import { applyCalibration, loadClientFeedback, seatFamily, wasCalibrated, type CalibrationRow } from "./calibration";
import type { MatchResult } from "@/lib/grants/engine";

// Locks the calibration consumer's safety invariants. These are load-bearing: the consumer runs
// on the scoring hot path with a live client, so cold-start identity, per-client isolation, and
// the ±1 / ~5-signal bound must be provable, not assumed.

const mk = (over: Partial<MatchResult> = {}): MatchResult =>
  ({
    fit_score: 3,
    seat_ref: "P0", // prime
    suppressed: false,
    disqualified: false,
    reasoning_context: { fit_score_derivation: "engine reasoning" },
    ...over,
  }) as MatchResult;

// A relevant pass: a GENUINELY PASSED card (decision "passed"), same seat family (prime) +
// overlapping focus ("health"), corrected 3 -> 2.
const pass = (over: Partial<CalibrationRow> = {}): CalibrationRow => ({
  agree: false,
  corrected_score: 2,
  engine_score: 3,
  engine_seat_ref: "P1",
  focusAreas: ["health"],
  decision: "passed",
  ...over,
});

// A BARE pass -- no corrected_score. This is the ONLY shape the product actually produces:
// the Disagree/Pass control (score-feedback.tsx, DecisionBar) posts a reason, never a score.
// So this path, not `pass()`, is what real calibration runs on.
const barePass = (over: Partial<CalibrationRow> = {}): CalibrationRow =>
  pass({ corrected_score: null, engine_score: null, ...over });

const FOCUS = ["health"];

describe("applyCalibration — identity on empty (cold-start guarantee)", () => {
  it("returns the exact input score when there is no feedback at all", () => {
    const m = mk();
    expect(applyCalibration(m, [], FOCUS)).toBe(m); // same reference — provably untouched
    expect(applyCalibration(m, [], FOCUS).fit_score).toBe(3);
  });

  it("is identity when feedback exists but none is relevant (wrong seat family)", () => {
    const m = mk({ seat_ref: "P0" });
    // Supporting-seat passes must not touch a prime-seat score.
    const rows = [pass({ engine_seat_ref: "S0" }), pass({ engine_seat_ref: "S1_2" })];
    expect(applyCalibration(m, rows, FOCUS)).toBe(m);
  });

  it("is identity when the focus area does not overlap (no cross-category bleed)", () => {
    const m = mk();
    const rows = [pass({ focusAreas: ["housing"] }), pass({ focusAreas: ["transportation"] })];
    expect(applyCalibration(m, rows, FOCUS)).toBe(m); // health grant, housing passes → untouched
  });

  it("never calibrates a suppressed or disqualified match", () => {
    const rows = Array.from({ length: 20 }, () => pass());
    expect(applyCalibration(mk({ suppressed: true }), rows, FOCUS).fit_score).toBe(3);
    expect(applyCalibration(mk({ disqualified: true }), rows, FOCUS).fit_score).toBe(3);
  });

  it("ignores direction-neutral disagreements on cards that were NOT passed (polarity guard)", () => {
    const m = mk();
    // Same seat + focus, plenty of them, but the cards are still pending — a bare 'Disagree'
    // could mean "too low", so it must never nudge the score down. Only a genuine PASS counts.
    const pending = Array.from({ length: 20 }, () => pass({ decision: "pending" }));
    expect(applyCalibration(m, pending, FOCUS)).toBe(m);
    const approved = Array.from({ length: 20 }, () => pass({ decision: "approved" }));
    expect(applyCalibration(m, approved, FOCUS)).toBe(m);
    const attemptFlag = Array.from({ length: 20 }, () => pass({ decision: null }));
    expect(applyCalibration(m, attemptFlag, FOCUS)).toBe(m); // suppressed-match false-negative flags
  });
});

describe("applyCalibration — ±1 cap and the ~5-signal threshold", () => {
  it("a single pass moves the score by nothing", () => {
    expect(applyCalibration(mk(), [pass()], FOCUS).fit_score).toBe(3);
  });

  it("four consistent passes still move nothing (below threshold)", () => {
    const rows = Array.from({ length: 4 }, () => pass());
    expect(applyCalibration(mk(), rows, FOCUS).fit_score).toBe(3);
  });

  it("about five consistent passes move the score down exactly one point", () => {
    const rows = Array.from({ length: 5 }, () => pass());
    expect(applyCalibration(mk(), rows, FOCUS).fit_score).toBe(2);
  });

  it("no amount of feedback moves the score more than one point", () => {
    const many = Array.from({ length: 100 }, () => pass());
    expect(applyCalibration(mk({ fit_score: 3 }), many, FOCUS).fit_score).toBe(2); // capped at -1
    // Even maximal corrections (3 -> 0) cap at a single point per re-score.
    const harsh = Array.from({ length: 100 }, () => pass({ corrected_score: 0 }));
    expect(applyCalibration(mk({ fit_score: 3 }), harsh, FOCUS).fit_score).toBe(2);
  });

  it("clamps at zero — never negative", () => {
    const many = Array.from({ length: 100 }, () => pass({ engine_score: 1, corrected_score: 0 }));
    expect(applyCalibration(mk({ fit_score: 1 }), many, FOCUS).fit_score).toBe(0);
  });

  it("a single harsh correction (3→0) still moves nothing — magnitude is clamped per pass", () => {
    // The un-clamped version moved the score on one row (s=-3, w=1/6, round(0.5)=1). Per-pass
    // clamping to [-1,0] makes a harsh correction count the same as any other single pass.
    expect(applyCalibration(mk(), [pass({ corrected_score: 0 })], FOCUS).fit_score).toBe(3);
  });
});

// The bare-pass path is the one that matters: it is 100% of real feedback. If this regresses,
// the feature is silently inert against everything the product collects (the shipped bug this
// PR's BARE_PASS=-1 fix corrects).
describe("applyCalibration — bare passes (the shape real feedback actually takes)", () => {
  it("a single bare pass moves nothing", () => {
    expect(applyCalibration(mk(), [barePass()], FOCUS).fit_score).toBe(3);
  });

  it("four bare passes still move nothing (below threshold)", () => {
    const rows = Array.from({ length: 4 }, () => barePass());
    expect(applyCalibration(mk(), rows, FOCUS).fit_score).toBe(3);
  });

  it("about five bare passes move the score down exactly one point", () => {
    const rows = Array.from({ length: 5 }, () => barePass());
    expect(applyCalibration(mk(), rows, FOCUS).fit_score).toBe(2);
  });

  it("bare passes never move more than one point, and floor at zero", () => {
    const many = Array.from({ length: 100 }, () => barePass());
    expect(applyCalibration(mk({ fit_score: 3 }), many, FOCUS).fit_score).toBe(2);
    expect(applyCalibration(mk({ fit_score: 1 }), many, FOCUS).fit_score).toBe(0);
  });

  it("bare passes are relevance-scoped exactly like graded passes (no cross-category bleed)", () => {
    const m = mk();
    const rows = Array.from({ length: 8 }, () => barePass({ focusAreas: ["housing"] }));
    expect(applyCalibration(m, rows, FOCUS)).toBe(m); // wrong focus → untouched (same reference)
  });
});

describe("applyCalibration — explainability", () => {
  it("annotates the reasoning when (and only when) it moved the score", () => {
    const moved = applyCalibration(mk(), Array.from({ length: 5 }, () => pass()), FOCUS);
    expect(moved.reasoning_context?.fit_score_derivation).toContain("Calibration: lowered 3→2");
    expect(moved.reasoning_context?.fit_score_derivation).toContain("engine reasoning"); // kept
    // No move → reasoning untouched.
    const still = applyCalibration(mk(), [pass()], FOCUS);
    expect(still.reasoning_context?.fit_score_derivation).toBe("engine reasoning");
  });
});

describe("wasCalibrated — the marker the report surfaces read is the one the note writes", () => {
  it("is true for a real calibration note and false otherwise", () => {
    // The exact note applyCalibration produced when it moved a score (asserted above).
    const moved = applyCalibration(mk(), Array.from({ length: 5 }, () => pass()), FOCUS);
    expect(wasCalibrated(moved.reasoning_context?.fit_score_derivation)).toBe(true);
    expect(wasCalibrated("engine reasoning")).toBe(false);
    expect(wasCalibrated(null)).toBe(false);
    expect(wasCalibrated(undefined)).toBe(false);
  });
});

describe("seatFamily", () => {
  it("maps raw seat_refs to cross-grant families", () => {
    expect(seatFamily("P0")).toBe("prime");
    expect(seatFamily("S1_2")).toBe("supporting");
    expect(seatFamily("NONE")).toBe("none");
    expect(seatFamily(null)).toBe("none");
  });
});

describe("loadClientFeedback — per-client isolation (load-bearing, not RLS)", () => {
  // Fake Supabase builder that ACTUALLY applies .eq filters, so a query missing the client_id
  // predicate would leak other clients' rows and fail the test.
  function fakeDb(allRows: Record<string, unknown>[]) {
    const eqCalls: [string, unknown][] = [];
    const builder: Record<string, unknown> = {
      _rows: allRows,
      select() {
        return builder;
      },
      eq(col: string, val: unknown) {
        eqCalls.push([col, val]);
        builder._rows = (builder._rows as Record<string, unknown>[]).filter((r) => r[col] === val);
        return builder;
      },
      then(resolve: (v: { data: unknown; error: null }) => void) {
        resolve({ data: builder._rows, error: null });
      },
    };
    return { db: { from: () => builder } as never, eqCalls };
  }

  const rowFor = (clientId: string, focus: string) => ({
    client_id: clientId,
    agree: false,
    corrected_score: 2,
    engine_score: 3,
    engine_seat_ref: "P0",
    grants: { focus_areas: [focus] },
    review_cards: { decision: "passed" },
  });

  it("returns only the requested client's rows and filters on client_id", async () => {
    const { db, eqCalls } = fakeDb([
      rowFor("A", "health"),
      rowFor("B", "health"), // another client — must never come back
      rowFor("A", "workforce"),
      rowFor("B", "workforce"),
    ]);
    const rows = await loadClientFeedback(db, "A");
    expect(rows).toHaveLength(2); // only A's two rows
    expect(rows.map((r) => r.focusAreas.flat())).toEqual([["health"], ["workforce"]]);
    expect(rows.every((r) => r.decision === "passed")).toBe(true); // decision embed maps through
    expect(eqCalls).toContainEqual(["client_id", "A"]); // the isolation predicate was applied
    // And prove the fake would have leaked B if the predicate were missing:
    expect([...eqCalls].some(([c]) => c === "client_id")).toBe(true);
  });
});
