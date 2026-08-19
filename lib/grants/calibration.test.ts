import { describe, it, expect } from "vitest";
import { applyCalibration, loadClientFeedback, seatFamily, type CalibrationRow } from "./calibration";
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

// A relevant pass: same seat family (prime) + overlapping focus ("health"), corrected 3 -> 2.
const pass = (over: Partial<CalibrationRow> = {}): CalibrationRow => ({
  agree: false,
  corrected_score: 2,
  engine_score: 3,
  engine_seat_ref: "P1",
  focusAreas: ["health"],
  ...over,
});

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
    expect(eqCalls).toContainEqual(["client_id", "A"]); // the isolation predicate was applied
    // And prove the fake would have leaked B if the predicate were missing:
    expect([...eqCalls].some(([c]) => c === "client_id")).toBe(true);
  });
});
