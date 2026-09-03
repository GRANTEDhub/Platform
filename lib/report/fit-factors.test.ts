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

  it("leads gate-first with the blocking factor and its reason (no band/label stitch)", () => {
    const view = viewFitFactors(scores({ seat_role: { rating: "weak", rationale: "seat is thin" } }));
    const s = blockingReason(view, 2, { calibrated: false });
    // Gate-first: "Capped by <factor>: <reason>" — NOT the old "Capped at conditional on <factor> —" that
    // glued a band word to an internal analyst label.
    expect(s).toBe("Capped by seat / role fit: seat is thin");
    expect(s).not.toContain("conditional");
    expect(s).not.toContain("Capped at");
    expect(s).not.toContain(" — ");
  });

  it("names the OTHER weak factors instead of a bare count", () => {
    // Two weak factors: the worst leads the sentence, the other is NAMED in "Also short:" — never the old
    // "(1 other factor also scored short.)" that pointed at nothing.
    const view = viewFitFactors(
      scores({
        seat_role: { rating: "weak", rationale: "seat is thin" },
        geographic: { rating: "weak", rationale: "out of area" },
      }),
    );
    const s = blockingReason(view, 2, { calibrated: false });
    expect(s).toContain("Capped by seat / role fit: seat is thin");
    expect(s).toContain("Also short: geographic fit.");
    expect(s).not.toMatch(/other factor/);
  });

  it("'also short' lists ONLY genuinely-weak factors (a moderate factor is not short)", () => {
    // A weak lead + a second weak + a moderate: the moderate is NOT "also short" (it is the middle band,
    // not a shortfall), and with a single trailing weak factor there is exactly one named, never a count.
    const view = viewFitFactors(
      scores({
        seat_role: { rating: "weak", rationale: "seat is thin" },
        geographic: { rating: "weak", rationale: "out of area" },
        mission: { rating: "moderate", rationale: "partial alignment" },
      }),
    );
    const s = blockingReason(view, 2, { calibrated: false });
    expect(s).toContain("Also short: geographic fit.");
    expect(s).not.toContain("mission");
    expect(s).not.toMatch(/other factor/);
  });

  it("is null on an all-strong card with no calibration (no reason to invent)", () => {
    expect(blockingReason(viewFitFactors(scores()), 3, { calibrated: false })).toBeNull();
  });

  it("scrubs the matcher's seat codes from a factor rationale (blocking sentence + table hover)", () => {
    // The rationale feeds both blockingReason and the client-visible factor-table hover, so a leaked
    // "S0_2" must be gone at the viewFitFactors read boundary.
    const view = viewFitFactors(
      scores({ seat_role: { rating: "weak", rationale: "fills a support role (S0_2) but cannot prime" } }),
    );
    expect(view.factors.find((f) => f.key === "seat_role")?.rationale).toBe("fills a support role but cannot prime");
    const s = blockingReason(view, 2, { calibrated: false });
    expect(s).not.toMatch(/S\d+_\d+/);
    expect(s).toContain("fills a support role but cannot prime");
  });
});

describe("viewFitFactors weakCount", () => {
  it("counts only genuinely-weak factors, EXCLUDING not-assessed (the bug fix)", () => {
    // One weak + one insufficient_data. weakCount is 1 (the weak one only) — a not-assessed factor is
    // unknown, not a shortfall, and must not be counted as one.
    const view = viewFitFactors(
      scores({
        seat_role: { rating: "weak", rationale: "seat is thin" },
        program_history: { rating: "insufficient_data" },
      }),
    );
    expect(view.weakCount).toBe(1);
  });

  it("counts multiple weak factors, still excluding not-assessed", () => {
    const view = viewFitFactors(
      scores({
        seat_role: { rating: "weak" },
        geographic: { rating: "weak" },
        cost_share: { rating: "insufficient_data" },
      }),
    );
    expect(view.weakCount).toBe(2);
  });

  it("is 0 when nothing is weak (a moderate factor is not 'weak')", () => {
    const view = viewFitFactors(scores({ mission: { rating: "moderate" } }));
    expect(view.weakCount).toBe(0);
  });
});
