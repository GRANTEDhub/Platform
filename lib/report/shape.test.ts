import { describe, it, expect } from "vitest";
import { toReportItem, type ReportCardRow } from "./shape";

// The QA-override client/staff trust boundary in toReportItem: a CLIENT surface may carry ONLY an
// `applied` verdict into its (RSC-serialized) props; the internal unverified/failed states are staff-only.
const row = (over: Partial<ReportCardRow> = {}): ReportCardRow => ({
  id: "c1",
  grant_id: "g1",
  fit_score: 3,
  proposed_role: null,
  decision: "pending",
  factor_scores: null,
  grants: null,
  ...over,
});

describe("toReportItem — QA verdict client/staff gate", () => {
  it("client + applied verdict → the applied badge passes through (client sees the corrected score's sources)", () => {
    const item = toReportItem(
      row({ qa_status: "applied", qa_fit_score: 2, qa_engine_fit_score: 3, qa_sources: ["https://bja.ojp.gov/x"] }),
      "client",
    );
    expect(item.fitScore).toBe(2); // coalesced
    expect(item.qa).toEqual({ status: "applied", from: 3, to: 2, sources: ["https://bja.ojp.gov/x"] });
  });

  it("client + unverified verdict → qa is NULLED (internal state never rides into a client prop)", () => {
    const item = toReportItem(row({ qa_status: "unverified" }), "client");
    expect(item.fitScore).toBe(3); // engine score stands
    expect(item.qa).toBeNull();
  });

  it("staff + unverified verdict → the full verdict is kept (staff see QA's internal state)", () => {
    const item = toReportItem(row({ qa_status: "unverified" }), "staff");
    expect(item.qa).toEqual({ status: "unverified" });
  });

  it("no QA (columns null) → qa is null on both sides (byte-identical to pre-0088)", () => {
    expect(toReportItem(row(), "client").qa).toBeNull();
    expect(toReportItem(row(), "staff").qa).toBeNull();
  });
});
