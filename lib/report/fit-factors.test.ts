import { describe, it, expect } from "vitest";
import { viewFitFactors, blockingReason } from "./fit-factors";
import type { FactorScores } from "@/types/database";

// blockingReason is the one bold "why this score" sentence shared by the client portal and the
// staff roadmap card. The calibration override is the load-bearing case: a calibration-lowered
// score must NOT be misattributed to a factor cap (the bug the shared helper fixes).

const scores = (over: Partial<Record<keyof FactorScores, { rating: string; rationale?: string }>> = {}) =>
  ({
    seat_role: { rating: "strong" },
    eligibility: { rating: "strong" },
    mission: { rating: "strong" },
    cost_share: { rating: "strong" },
    geographic: { rating: "strong" },
    program_history: { rating: "strong" },
    ...over,
  }) as unknown as FactorScores;

describe("blockingReason", () => {
  it("states the calibration cause and NEVER a factor cap when calibration fired", () => {
    // All-strong card lowered by calibration: the factor path would return null (no reason at
    // all next to a visibly dropped score). The calibrated branch must speak instead.
    const view = viewFitFactors(scores());
    const s = blockingReason(view, 2, { calibrated: true });
    expect(s).toBe("Adjusted below the machine score based on past feedback on similar grants.");
    expect(s).not.toContain("Capped");
  });

  it("does not attribute a calibrated drop to a genuinely weak factor", () => {
    // Even with a real weak factor present, a calibration-driven score states the calibration
    // cause — the weak row still shows in the table, but the sentence isn't a false 'capped on X'.
    const view = viewFitFactors(scores({ seat_role: { rating: "weak", rationale: "seat is thin" } }));
    const s = blockingReason(view, 2, { calibrated: true });
    expect(s).toContain("past feedback");
    expect(s).not.toContain("seat");
  });

  it("falls back to the factor-cap sentence when calibration did NOT fire", () => {
    const view = viewFitFactors(scores({ seat_role: { rating: "weak", rationale: "seat is thin" } }));
    const s = blockingReason(view, 2, { calibrated: false });
    expect(s).toContain("Capped at");
    expect(s).toContain("seat / role fit");
    expect(s).toContain("seat is thin");
  });

  it("is null on an all-strong card with no calibration (no reason to invent)", () => {
    expect(blockingReason(viewFitFactors(scores()), 3, { calibrated: false })).toBeNull();
  });
});
