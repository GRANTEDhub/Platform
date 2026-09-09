import { describe, it, expect } from "vitest";
import { buildQueue, rollUpQueue } from "./report-queue";
import { toReportItem, type ReportCardRow } from "./shape";

// The "Combined ceiling" rollup sums PUBLISHED award maxima across the awaiting queue — its client-facing
// title asserts real maxima, "NOT a forecast". A pool÷awards estimate ("~$598K est.") is a derived per-award
// AVERAGE, not a published ceiling, so it must NOT be blended into that sum (regression: toReportItem's
// awardRange gained the estimate fallback, which ceilingOf would otherwise parse into the total).

const grants = (over: Record<string, unknown> = {}): ReportCardRow["grants"] =>
  ({
    title: "T",
    funder: "F",
    submission_deadline: null,
    award_range_min: null,
    award_range_max: null,
    award_range_is_estimate: null,
    num_awards: null,
    total_funding: null,
    focus_areas: [],
    ...over,
  }) as ReportCardRow["grants"];

// A pending, unreleased card → the "admin" (awaiting) bucket the rollup sums over.
const card = (id: string, grantsOver: Record<string, unknown>): ReportCardRow => ({
  id,
  grant_id: id,
  fit_score: 3,
  proposed_role: null,
  decision: "pending",
  factor_scores: null,
  sme_released_at: null,
  grants: grants(grantsOver),
});

describe("rollUpQueue — Combined ceiling excludes pool÷awards estimates", () => {
  it("sums a real published maximum but counts an estimate-only grant as UNPRICED", () => {
    const real = toReportItem(card("real", { award_range_min: "$100,000", award_range_max: "$500,000" }), "staff");
    const est = toReportItem(
      card("est", { award_range_min: "0", award_range_max: "0", total_funding: "$11,960,000", num_awards: "20" }),
      "staff",
    );
    expect(real.awardRange).toBe("$100K – $500K");
    expect(est.awardRange).toBe("~$598K est."); // derived per-award average, self-labeled

    const rows = buildQueue([real, est], { hasReleaseGate: true, primaryBucket: "admin" });
    const rollup = rollUpQueue(rows, "admin");

    expect(rollup.awaiting).toBe(2);
    // Only the real range's ceiling ($500K) is summed; the estimate is NOT blended into the published total.
    expect(rollup.ceiling).toBe("$500K");
    expect(rollup.ceilingUnpriced).toBe(1); // the estimate grant is unpriced, exactly as before the fallback
  });
});
