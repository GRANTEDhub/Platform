import { describe, it, expect } from "vitest";
import { buildAlertData, alertFitSignature, draftFitStillFresh, draftStillFresh } from "./data";
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

  // The deadline tile shows the ABSOLUTE date only — the "N days left" countdown sub-line was REMOVED
  // (Shannon, 2026-09-15): a time-relative value baked into a save-once draft goes stale on the calendar
  // clock, so it was the sole thing forcing the deadline into the freshness check. A static date drops out.
  it("the deadline tile is the highlighted date only — no countdown sub-line", () => {
    const s = buildAlertData(grant({ submission_deadline: "2027-01-15" }), card(), null).stats.find((x) => x.label === "deadline");
    expect(s?.highlight).toBe(true);
    expect(s?.value).toBe("Jan 15");
    expect(s).not.toHaveProperty("sub");
  });

  // A long PROSE award (AR-state grants store award bounds as prose — "Not stated" ×
  // "Maximum per project set at the beginning of each cycle") joined to ~60 chars blew the fixed
  // stats card out (the `1fr` grid track won't shrink below nowrap content, so the tile's own
  // ellipsis never fired). buildStats collapses a long award to a clean "Varies"; a clean $ range
  // is short and kept verbatim (#570 preview fix).
  it("a long PROSE award collapses to 'Varies' for the stat tile; a clean $ range is kept", () => {
    const proseAward = buildAlertData(
      grant({ award_range_min: "Not stated", award_range_max: "Maximum per project set at the beginning of each cycle" }),
      card(),
      null,
    ).stats.find((s) => s.label.startsWith("award"));
    expect(proseAward?.value).toBe("Varies");

    const cleanAward = buildAlertData(grant({ award_range_min: "50000", award_range_max: "250000" }), card(), null).stats.find(
      (s) => s.label.startsWith("award"),
    );
    expect(cleanAward?.value).toBe("$50K – $250K");
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

// draftStillFresh is the ONE predicate both the single-send guard (getOrCreateDraftAlert) AND the
// multi-select BATCH path (prepare skip / send / preview) share, so the batch's raw getDraftAlert reads
// can't ship a draft single-send would regenerate (#570 Claude Code Review — the batch bypassed the guard).
describe("draft staleness — draftStillFresh (shared single-send + batch predicate)", () => {
  const daysFromNow = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);
  const ctxOf = (c: ReviewCard, g: Grant, isLead = false) => ({ card: c, grant: g, isLead });

  it("COLD outreach (prospect card) is ALWAYS fresh — that template renders neither signal", () => {
    const stored = buildAlertData(grant({ submission_deadline: daysFromNow(10) }), card({ fit_score: 3, fit_narrative: "x", fit_narrative_fit_score: 3 }), null);
    // A prospect card whose live verdict fully contradicts the snapshot is STILL fresh (no fit/countdown shown).
    const prospectLive = card({ card_type: "prospect", fit_score: 1, fit_narrative: null, concept_synopsis: null });
    expect(draftStillFresh(stored, ctxOf(prospectLive, grant({ submission_deadline: daysFromNow(-5) })))).toBe(true);
  });

  it("a LEAD (isLead) is ALWAYS fresh regardless of drift", () => {
    const stored = buildAlertData(grant({ submission_deadline: daysFromNow(10) }), card({ fit_score: 3 }), null);
    expect(draftStillFresh(stored, ctxOf(card({ fit_score: 1 }), grant({ submission_deadline: daysFromNow(-5) }), true))).toBe(true);
  });

  it("WARM client is fresh iff the fit signature matches; the deadline no longer participates", () => {
    const g = grant({ submission_deadline: daysFromNow(10) });
    const c = card({ fit_score: 3, fit_narrative: "why this fits", fit_narrative_fit_score: 3 });
    const stored = buildAlertData(g, c, null); // snapshot from this exact card + grant
    expect(draftStillFresh(stored, ctxOf(c, g))).toBe(true);
    // fit moved (an applied QA demote) → stale
    const demoted = card({ fit_score: 3, qa_status: "applied", qa_fit_score: 2, qa_engine_fit_score: 3, qa_narrative: "cannot prime", fit_narrative: "why this fits", fit_narrative_fit_score: 2 });
    expect(draftStillFresh(stored, ctxOf(demoted, g))).toBe(false);
    // the deadline PASSING does NOT make it stale — the countdown is gone, so the deadline is a frozen date
    // the freshness check no longer considers (this is what killed the day-tick re-enrich + send churn).
    expect(draftStillFresh(stored, ctxOf(c, grant({ submission_deadline: daysFromNow(-5) })))).toBe(true);
  });
});
