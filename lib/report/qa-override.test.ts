import { describe, it, expect } from "vitest";
import { resolveFit, type QaOverrideRow } from "./qa-override";
import type { FactorScores } from "@/types/database";

const engineFactors: FactorScores = {
  seat_role: { rating: "moderate", rationale: "seat" },
  eligibility: { rating: "moderate", rationale: "elig" },
  geographic: { rating: "strong", rationale: "in-state" },
  program_history: { rating: "moderate", rationale: "history" },
  cost_share: { rating: "strong", rationale: "no match" },
  mission: { rating: "strong", rationale: "mission" },
};
const qaFactors: FactorScores = { ...engineFactors, seat_role: { rating: "weak", rationale: "asterisk — cannot prime" } };

const row = (over: Partial<QaOverrideRow> = {}): QaOverrideRow => ({
  fit_score: 3,
  factor_scores: engineFactors,
  ...over,
});

describe("resolveFit — QA override coalesce + staleness", () => {
  it("no QA (all qa_* null) → engine score/factors, no badge, no narrative (byte-identical to pre-0088)", () => {
    const r = resolveFit(row());
    expect(r.fitScore).toBe(3);
    expect(r.factorScores).toBe(engineFactors);
    expect(r.qa).toBeNull();
    expect(r.narrative).toBeNull();
  });

  it("applied + fresh (snapshot === fit_score) → QA score/factors/sources/narrative shown, badge applied", () => {
    const r = resolveFit(
      row({
        qa_status: "applied",
        qa_fit_score: 2,
        qa_engine_fit_score: 3,
        qa_factor_scores: qaFactors,
        qa_sources: ["https://bja.ojp.gov/x", "https://bja.ojp.gov/x", ""],
        qa_narrative: "The county cannot apply as a standalone prime; the fundable lane is an MOU with Blytheville.",
      }),
    );
    expect(r.fitScore).toBe(2);
    expect(r.factorScores).toBe(qaFactors);
    expect(r.qa).toEqual({ status: "applied", from: 3, to: 2, sources: ["https://bja.ojp.gov/x", "https://bja.ojp.gov/x"] });
    expect(r.narrative).toBe("The county cannot apply as a standalone prime; the fundable lane is an MOU with Blytheville.");
  });

  it("applied + fresh but the narrative is empty/whitespace → null (renders the engine paragraph)", () => {
    const r = resolveFit(row({ qa_status: "applied", qa_fit_score: 2, qa_engine_fit_score: 3, qa_narrative: "   " }));
    expect(r.fitScore).toBe(2);
    expect(r.narrative).toBeNull();
  });

  it("applied but STALE (engine re-scored: snapshot 3 ≠ fit_score 2) → override + narrative IGNORED, engine score, no badge", () => {
    const r = resolveFit(
      row({ fit_score: 2, qa_status: "applied", qa_fit_score: 1, qa_engine_fit_score: 3, qa_factor_scores: qaFactors, qa_narrative: "stale demote prose" }),
    );
    expect(r.fitScore).toBe(2); // the fresh engine score, NOT the stale qa_fit_score 1
    expect(r.factorScores).toBe(engineFactors);
    expect(r.qa).toBeNull(); // no misleading "QA lowered" badge over a re-scored card
    expect(r.narrative).toBeNull(); // a stale narrative must not sit on a freshly re-scored card
  });

  it("unverified → engine score stands, badge unverified (score columns are null by write-time contract)", () => {
    const r = resolveFit(row({ qa_status: "unverified", qa_fit_score: null, qa_factor_scores: null, qa_engine_fit_score: null }));
    expect(r.fitScore).toBe(3);
    expect(r.factorScores).toBe(engineFactors);
    expect(r.qa).toEqual({ status: "unverified" });
  });

  it("failed → engine score stands, badge failed", () => {
    const r = resolveFit(row({ qa_status: "failed" }));
    expect(r.fitScore).toBe(3);
    expect(r.qa).toEqual({ status: "failed" });
  });

  it("null engine score is preserved (an unscored card is an absence, never coerced)", () => {
    const r = resolveFit(row({ fit_score: null }));
    expect(r.fitScore).toBeNull();
    expect(r.qa).toBeNull();
  });

  it("applied with a missing qa_fit_score falls through to the engine score (defensive)", () => {
    const r = resolveFit(row({ qa_status: "applied", qa_fit_score: null, qa_engine_fit_score: 3 }));
    expect(r.fitScore).toBe(3);
    expect(r.qa).toBeNull();
  });
});
