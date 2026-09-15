import { describe, it, expect } from "vitest";
import { buildAlertData, alertFitSignature, draftFitStillFresh } from "./data";
import type { Grant, ReviewCard } from "@/types/database";

// Minimal fixtures — buildAlertData reads a handful of grant fields (all null-safe in the helpers) and the
// card's resolveFit columns. Cast partials keep the fixtures to what these assertions exercise.
const grant = (o: Partial<Grant> = {}): Grant =>
  ({ title: "EPA Brownfields Job Training", funder: "EPA", submission_deadline: "2027-01-15", ...o }) as unknown as Grant;

const card = (o: Partial<ReviewCard> & Record<string, unknown> = {}): ReviewCard =>
  ({
    fit_score: 3,
    factor_scores: null,
    qa_fit_score: null,
    qa_status: null,
    qa_engine_fit_score: null,
    fit_narrative: null,
    fit_narrative_fit_score: null,
    fit_narrative_edited: false,
    concept_synopsis: null,
    card_type: "client",
    ...o,
  }) as unknown as ReviewCard;

describe("buildAlertData — fit-score block + Grant Intelligence (PR B)", () => {
  it("fitScore + label come from resolveFit / FIT_BAND; grantIntelligence is the fit narrative when present", () => {
    const d = buildAlertData(
      grant(),
      card({ fit_score: 3, fit_narrative: "An eligible community college whose workforce mission maps onto this.", fit_narrative_fit_score: 3, concept_synopsis: "the matcher synopsis" }),
      null,
    );
    expect(d.fitScore).toBe(3);
    expect(d.fitScoreLabel).toBe("Strong fit");
    // The fit narrative WINS over the matcher synopsis.
    expect(d.grantIntelligence).toBe("An eligible community college whose workforce mission maps onto this.");
  });

  it("a displayed-2 reads 'Conditional'; grantIntelligence falls back to concept_synopsis when there is no narrative", () => {
    const d = buildAlertData(grant(), card({ fit_score: 2, fit_narrative: null, concept_synopsis: "the matcher synopsis" }), null);
    expect(d.fitScore).toBe(2);
    expect(d.fitScoreLabel).toBe("Conditional");
    expect(d.grantIntelligence).toBe("the matcher synopsis");
  });

  it("no narrative AND no synopsis → grantIntelligence null (the template renders its static line)", () => {
    const d = buildAlertData(grant(), card({ fit_score: 1, fit_narrative: null, concept_synopsis: null }), null);
    expect(d.fitScoreLabel).toBe("Weak");
    expect(d.grantIntelligence).toBeNull();
  });

  // The deadline tile's "N days left" countdown (buildStats → deadlineDaysLeftSub). Relative to
  // render time, so asserted by SHAPE (not an exact count) to stay TZ-robust; the direction gates
  // (future → present, past/undated → absent) are the real contract.
  const daysFromNow = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);
  const deadlineStat = (deadline: string) =>
    buildAlertData(grant({ submission_deadline: deadline }), card(), null).stats.find((s) => s.label === "deadline");

  it("a firm FUTURE deadline gets an 'N days left' countdown sub-line", () => {
    const s = deadlineStat(daysFromNow(10));
    expect(s?.highlight).toBe(true);
    expect(s?.sub).toMatch(/^\d+ days? left$/);
  });

  it("a PAST deadline carries no countdown (closed — the sweep handles it)", () => {
    expect(deadlineStat(daysFromNow(-5))?.sub).toBeUndefined();
  });

  it("a rolling/undated deadline carries no countdown", () => {
    expect(deadlineStat("Rolling")?.sub).toBeUndefined();
  });

  it("an applied QA demote drives the DISPLAYED fit + its narrative (resolveFit coalesce)", () => {
    // engine 3, QA applied a demote to 2 (fresh) with a grounded reason → the block shows 2/Conditional and
    // the QA reason as Grant Intelligence.
    const d = buildAlertData(
      grant(),
      card({
        fit_score: 3,
        qa_status: "applied",
        qa_fit_score: 2,
        qa_engine_fit_score: 3,
        qa_narrative: "Cannot prime as a disparate jurisdiction; the lane is an MOU.",
        fit_narrative: "an affirmative paragraph that must NOT win under an applied demote",
        fit_narrative_fit_score: 2,
      }),
      null,
    );
    expect(d.fitScore).toBe(2);
    expect(d.fitScoreLabel).toBe("Conditional");
    expect(d.grantIntelligence).toBe("Cannot prime as a disparate jurisdiction; the lane is an MOU.");
  });
});

// The save-once draft's fit-score/Grant Intelligence snapshot can go stale when a QA apply, the
// fit-analysis drain, or an engine rematch moves the card's resolveFit AFTER the draft is generated
// (none of those paths invalidates the draft). getOrCreateDraftAlert re-derives this signature and
// regenerates a drifted draft so the sent PDF can't contradict the card's current verdict (PR B, #570).
describe("draft staleness — alertFitSignature / draftFitStillFresh", () => {
  it("alertFitSignature: narrative wins over synopsis, else synopsis, else null", () => {
    expect(
      alertFitSignature(card({ fit_score: 3, fit_narrative: "why this fits", fit_narrative_fit_score: 3, concept_synopsis: "syn" })),
    ).toEqual({ fitScore: 3, grantIntelligence: "why this fits" });
    expect(alertFitSignature(card({ fit_score: 2, fit_narrative: null, concept_synopsis: "syn" }))).toEqual({
      fitScore: 2,
      grantIntelligence: "syn",
    });
    expect(alertFitSignature(card({ fit_score: 1, fit_narrative: null, concept_synopsis: null }))).toEqual({
      fitScore: 1,
      grantIntelligence: null,
    });
  });

  it("FRESH when the stored snapshot matches the card's current resolveFit", () => {
    const c = card({ fit_score: 3, fit_narrative: "why this fits", fit_narrative_fit_score: 3 });
    expect(draftFitStillFresh({ fitScore: 3, grantIntelligence: "why this fits" }, c)).toBe(true);
  });

  it("STALE when a QA demote lands after the draft (displayed fit moved 3 → 2)", () => {
    // The draft snapshotted 3; the card now carries an applied, fresh QA demote to 2.
    const c = card({
      fit_score: 3,
      qa_status: "applied",
      qa_fit_score: 2,
      qa_engine_fit_score: 3,
      qa_narrative: "Cannot prime as a disparate jurisdiction.",
      fit_narrative: "an affirmative paragraph the demote overrides",
      fit_narrative_fit_score: 2,
    });
    expect(draftFitStillFresh({ fitScore: 3, grantIntelligence: "the old paragraph" }, c)).toBe(false);
  });

  it("STALE when only the narrative changed (fit score unchanged)", () => {
    const c = card({ fit_score: 2, fit_narrative: "the regenerated paragraph", fit_narrative_fit_score: 2 });
    expect(draftFitStillFresh({ fitScore: 2, grantIntelligence: "the original paragraph" }, c)).toBe(false);
  });

  it("a legacy draft with no snapshotted signature reads STALE (regenerates into the new format)", () => {
    expect(draftFitStillFresh({}, card({ fit_score: 3, fit_narrative: "x", fit_narrative_fit_score: 3 }))).toBe(false);
  });
});
