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

  it("scrubs the matcher's seat codes from a stored narrative at the read boundary", () => {
    // A narrative stored before narrativeGuard scrubbed codes must still display clean on every surface.
    const r = resolveFit(
      row({
        fit_score: 2,
        qa_status: "none",
        qa_fit_score: null,
        qa_engine_fit_score: 2,
        qa_narrative: "It fills a research unit (S0_2) and community engagement (S0_6), but cannot prime.",
      }),
    );
    expect(r.narrative).toBe("It fills a research unit and community engagement, but cannot prime.");
    expect(r.narrative).not.toMatch(/S\d+_\d+/);
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

  it("affirm/flag clearing patch (status 'none', qa_fit_score null) with a FRESH narrative → narrative shown, engine score, no badge", () => {
    // The verdict narrative is decoupled from the score override: an affirm/flag carries reasoning with NO
    // score change. Snapshot is fresh (3 === 3), qa_fit_score null → engine score stands, no applied badge,
    // but the reasoning paragraph renders in place of the engine one.
    const r = resolveFit(
      row({
        qa_status: "none",
        qa_fit_score: null,
        qa_engine_fit_score: 3,
        qa_narrative: "Genuinely in the workforce lane; the real hurdle is a HAZWOPER track the college does not run.",
      }),
    );
    expect(r.fitScore).toBe(3); // engine score — no score override
    expect(r.factorScores).toBe(engineFactors);
    expect(r.qa).toBeNull(); // 'none' status carries no badge
    expect(r.narrative).toBe("Genuinely in the workforce lane; the real hurdle is a HAZWOPER track the college does not run.");
  });

  it("affirm/flag narrative goes STALE on an engine re-score (snapshot 3 ≠ fit_score 2) → engine paragraph", () => {
    const r = resolveFit(
      row({ fit_score: 2, qa_status: "none", qa_fit_score: null, qa_engine_fit_score: 3, qa_narrative: "stale affirm prose" }),
    );
    expect(r.fitScore).toBe(2);
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

describe("resolveFit — fit-analysis narrative ownership (migration 0099)", () => {
  it("go (displayed 3) with a fresh fit_narrative → it WINS over the qa_narrative", () => {
    const r = resolveFit(
      row({
        fit_score: 3,
        fit_narrative: "An eligible community college whose workforce mission maps directly onto what this funds.",
        fit_narrative_fit_score: 3,
        qa_status: "none",
        qa_engine_fit_score: 3,
        qa_narrative: "the QA affirm reasoning that should be superseded",
      }),
    );
    expect(r.fitScore).toBe(3);
    expect(r.narrative).toBe("An eligible community college whose workforce mission maps directly onto what this funds.");
  });

  it("marginal (displayed 2) with a fresh fit_narrative → it wins", () => {
    const r = resolveFit(row({ fit_score: 2, fit_narrative: "Genuinely in the lane; lock a prime before the deadline.", fit_narrative_fit_score: 2 }));
    expect(r.fitScore).toBe(2);
    expect(r.narrative).toBe("Genuinely in the lane; lock a prime before the deadline.");
  });

  it("no-go (displayed 1) → the fit_narrative is IGNORED (direction gate); the qa_narrative owns it", () => {
    const r = resolveFit(
      row({
        fit_score: 1,
        fit_narrative: "an affirmative fit paragraph that must NOT show on a no-go",
        fit_narrative_fit_score: 1,
        qa_status: "none",
        qa_engine_fit_score: 1,
        qa_narrative: "Cannot prime this program as a standalone applicant.",
      }),
    );
    expect(r.fitScore).toBe(1);
    expect(r.narrative).toBe("Cannot prime this program as a standalone applicant.");
  });

  it("QA demoted 3→2 (applied+fresh) with a MATCHING fit_narrative snapshot (2) → qa_narrative STILL wins (defers to the grounded demote reason)", () => {
    // The #564 ownership fix: a QA demote lands at DISPLAYED 2 (marginal), and the fit-analysis narrative was
    // (wrongly) eligible there. Even with a fresh, snapshot-matching fit_narrative, the grounded qa_narrative
    // (the disqualifying reason) must win — the fit-analysis pass has no access to it, so it can't be right.
    const r = resolveFit(
      row({
        fit_score: 3,
        fit_narrative: "an ungrounded affirmative paragraph that must NOT replace the grounded demote reason",
        fit_narrative_fit_score: 2, // matches the displayed 2 — would have won before the fix
        qa_status: "applied",
        qa_fit_score: 2,
        qa_engine_fit_score: 3,
        qa_narrative: "Cannot prime as a disparate jurisdiction; the fundable lane is an MOU with the county.",
      }),
    );
    expect(r.fitScore).toBe(2);
    expect(r.narrative).toBe("Cannot prime as a disparate jurisdiction; the fundable lane is an MOU with the county.");
  });

  it("QA demoted 3→2 (applied+fresh) but fit_narrative snapshot is stale (3 ≠ displayed 2) → fit_narrative ignored, qa_narrative shows", () => {
    // A card whose displayed score is now 2 via a QA demote: the fit_narrative was written for the engine's 3,
    // so its snapshot (3) no longer matches the displayed 2 → withheld. The QA demote narrative owns the card.
    const r = resolveFit(
      row({
        fit_score: 3,
        fit_narrative: "written for a clean 3 — now stale under the demote",
        fit_narrative_fit_score: 3,
        qa_status: "applied",
        qa_fit_score: 2,
        qa_engine_fit_score: 3,
        qa_narrative: "The demote reasoning that owns the marginal card now.",
      }),
    );
    expect(r.fitScore).toBe(2);
    expect(r.narrative).toBe("The demote reasoning that owns the marginal card now.");
  });

  it("fit_narrative snapshot stale after an engine re-score (2 ≠ displayed 3) → ignored; falls back", () => {
    const r = resolveFit(row({ fit_score: 3, fit_narrative: "written when the card was a 2", fit_narrative_fit_score: 2 }));
    expect(r.fitScore).toBe(3);
    expect(r.narrative).toBeNull(); // stale fit_narrative withheld, no qa_narrative → engine paragraph
  });

  it("fit_narrative columns absent → qa_narrative / engine paragraph exactly as pre-0099 (byte-identical)", () => {
    const r = resolveFit(row({ fit_score: 2, qa_status: "none", qa_engine_fit_score: 2, qa_narrative: "the QA reasoning" }));
    expect(r.narrative).toBe("the QA reasoning");
  });

  it("scrubs seat codes from a stored fit_narrative at the read boundary", () => {
    const r = resolveFit(row({ fit_score: 3, fit_narrative: "Fills the lead applicant seat (P0) with a workforce program.", fit_narrative_fit_score: 3 }));
    expect(r.narrative).toBe("Fills the lead applicant seat with a workforce program.");
    expect(r.narrative).not.toMatch(/[SP]\d/);
  });
});

describe("resolveFit — human-edit narrative lock (migration 0100)", () => {
  it("edited narrative SURVIVES a benign band move: snapshot 3, displayed 2 → still shown (snapshot bypass)", () => {
    // A staffer edited the paragraph on a clean 3; a rematch later nudged the card to 2. A MACHINE narrative
    // would be withheld here (stale snapshot), but a human edit is honored on any go/marginal regardless.
    const r = resolveFit(
      row({ fit_score: 2, fit_narrative: "The staffer's corrected fit rationale.", fit_narrative_fit_score: 3, fit_narrative_edited: true }),
    );
    expect(r.fitScore).toBe(2);
    expect(r.narrative).toBe("The staffer's corrected fit rationale.");
  });

  it("edited narrative on a NO-GO (displayed 1) → still WITHHELD (direction gate is absolute)", () => {
    const r = resolveFit(
      row({
        fit_score: 1,
        fit_narrative: "an edited affirmative paragraph that must NOT show on a no-go",
        fit_narrative_fit_score: 3,
        fit_narrative_edited: true,
        qa_status: "none",
        qa_engine_fit_score: 1,
        qa_narrative: "Cannot prime this program.",
      }),
    );
    expect(r.fitScore).toBe(1);
    expect(r.narrative).toBe("Cannot prime this program."); // qa_narrative owns the no-go, not the human edit
  });

  it("edited narrative on an APPLIED QA demote → still WITHHELD (qa_narrative owns it)", () => {
    const r = resolveFit(
      row({
        fit_score: 3,
        fit_narrative: "an edited affirmative paragraph that must defer to the grounded demote",
        fit_narrative_fit_score: 2,
        fit_narrative_edited: true,
        qa_status: "applied",
        qa_fit_score: 2,
        qa_engine_fit_score: 3,
        qa_narrative: "Cannot prime as a disparate jurisdiction.",
      }),
    );
    expect(r.fitScore).toBe(2);
    expect(r.narrative).toBe("Cannot prime as a disparate jurisdiction.");
  });

  it("a MACHINE narrative (edited=false) with a stale snapshot is still withheld — the bypass is edited-only", () => {
    const r = resolveFit(
      row({ fit_score: 2, fit_narrative: "machine paragraph written for a 3", fit_narrative_fit_score: 3, fit_narrative_edited: false }),
    );
    expect(r.narrative).toBeNull(); // unchanged pre-0100 behavior for machine narratives
  });
});
