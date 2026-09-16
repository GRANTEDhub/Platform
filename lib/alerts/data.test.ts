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

  // AR-state grants dump long free-text into fields built for tidy numbers, which clipped/blew out the
  // fixed stat strip (Shannon's real MS County cards, 2026-09-15). buildStats NORMALIZES via the reused
  // grant-list helpers: a pure-placeholder OR prose-sentence award collapses to a clean "Not stated"; a
  // clean $ range is kept verbatim; a junk deadline → "No deadline"; a rolling one → "Rolling"; and a junk
  // award-count tile is dropped rather than surfaced. (The template's per-tile ellipsis clamp is the
  // universal backstop for anything in between.)
  const awardTile = (min: string, max: string) =>
    buildAlertData(grant({ award_range_min: min, award_range_max: max }), card(), null).stats.find((s) =>
      s.label.startsWith("award range"),
    )?.value;
  const deadlineTile = (d: string | null) =>
    buildAlertData(grant({ submission_deadline: d }), card(), null).stats.find((s) => s.label === "deadline")?.value;

  it("a pure-placeholder award collapses to 'Not stated' (the exact MS County junk)", () => {
    expect(awardTile("Not available", "Not available")).toBe("Not stated");
    expect(awardTile("Unknown", "Unknown")).toBe("Not stated");
  });

  it("a prose-SENTENCE award collapses to 'Not stated' (RTP — the one that blew the strip apart)", () => {
    expect(awardTile("Not stated", "Maximum per project set at the beginning of each funding cycle")).toBe("Not stated");
  });

  it("a clean $ range is kept verbatim", () => {
    expect(awardTile("50000", "250000")).toBe("$50K – $250K");
  });

  it("the deadline tile normalizes junk to 'No deadline' and a rolling intake to 'Rolling'", () => {
    expect(deadlineTile("Not available - verify at fly.arkansas.gov")).toBe("No deadline");
    expect(deadlineTile("Unknown -- funding varies by federal fiscal year appropriation")).toBe("No deadline");
    expect(deadlineTile("Applications accepted on a rolling basis")).toBe("Rolling");
    expect(deadlineTile("2027-01-15")).toBe("Jan 15"); // a real date still renders clean
  });

  it("the strip is ALWAYS 4 tiles; a junk/missing award-COUNT shows 'Not stated', never dropped", () => {
    // Shannon, 2026-09-15: always 4 tiles for visual consistency — a junk/missing value shows "Not stated"
    // rather than dropping the tile (reversing the earlier junk-drop that left a 3-cell row).
    const stats = buildAlertData(
      grant({ award_range_min: "50000", award_range_max: "250000", num_awards: "Unknown" }),
      card(),
      null,
    ).stats;
    expect(stats).toHaveLength(4);
    expect(stats.map((s) => s.label)).toEqual(["award range", "match required", "awards", "deadline"]);
    expect(stats.find((s) => s.label === "awards")?.value).toBe("Not stated");
    // A LONG placeholder count ("Not available", 13 chars) → "Not stated", NOT the truncated "Not availab…"
    // (placeholder checked on the raw string before shortAwards slices it) — Claude Code Review.
    const longPlaceholder = buildAlertData(grant({ award_range_min: "50000", award_range_max: "250000", num_awards: "Not available" }), card(), null).stats;
    expect(longPlaceholder.find((s) => s.label === "awards")?.value).toBe("Not stated");
    // A grant missing award + match + count entirely is STILL a full 4-wide strip of clean labels.
    const bare = buildAlertData(grant({ award_range_min: null, award_range_max: null, cost_share: null, num_awards: null, submission_deadline: null }), card(), null).stats;
    expect(bare.map((s) => s.value)).toEqual(["Not stated", "Not stated", "Not stated", "No deadline"]);
  });

  it("the 'award · est.' qualifier only labels a REAL figure, never the 'Not stated' fallback", () => {
    // engine sets award_range_is_estimate=true precisely when BOTH bounds are null → the label must not read
    // "award · est." over a "Not stated" value (an estimate of nothing) — Claude Code Review #571.
    const nullEst = buildAlertData(grant({ award_range_min: null, award_range_max: null, award_range_is_estimate: true }), card(), null).stats[0];
    expect(nullEst.value).toBe("Not stated");
    expect(nullEst.label).toBe("award range");
    // A real estimate figure keeps the "· est." qualifier.
    const realEst = buildAlertData(grant({ award_range_min: "50000", award_range_max: "250000", award_range_is_estimate: true }), card(), null).stats[0];
    expect(realEst.value).toBe("$50K – $250K");
    expect(realEst.label).toBe("award · est.");
  });

  it("headlineHtml wraps the distinctive word in an orange-italic <em> (EmphasizedTitle parity); headline stays plain", () => {
    const d = buildAlertData(grant({ title: "Airport Aid Program" }), card({ fit_score: 2 }), null);
    expect(d.headline).toBe("Airport Aid Program");
    expect(d.headlineHtml).toContain('<em style="font-style:italic;color:#E4761F;">Airport</em>');
    expect((d.headlineHtml.match(/<em /g) || []).length).toBe(1); // exactly one emphasized word
    // The plain words are escaped, not wrapped.
    expect(d.headlineHtml).toContain("Aid Program");
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
      alertFitSignature(card({ fit_score: 3, fit_narrative: "why this fits", fit_narrative_fit_score: 3, concept_synopsis: "syn" }), grant()),
    ).toEqual({ fitScore: 3, grantIntelligence: "why this fits" });
    expect(alertFitSignature(card({ fit_score: 2, fit_narrative: null, concept_synopsis: "syn" }), grant())).toEqual({
      fitScore: 2,
      grantIntelligence: "syn",
    });
    expect(alertFitSignature(card({ fit_score: 1, fit_narrative: null, concept_synopsis: null }), grant())).toEqual({
      fitScore: 1,
      grantIntelligence: null,
    });
  });

  it("FRESH when the stored snapshot matches the card's current resolveFit", () => {
    const c = card({ fit_score: 3, fit_narrative: "why this fits", fit_narrative_fit_score: 3 });
    expect(draftFitStillFresh({ fitScore: 3, grantIntelligence: "why this fits" }, c, grant())).toBe(true);
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
    expect(draftFitStillFresh({ fitScore: 3, grantIntelligence: "the old paragraph" }, c, grant())).toBe(false);
  });

  it("STALE when only the narrative changed (fit score unchanged)", () => {
    const c = card({ fit_score: 2, fit_narrative: "the regenerated paragraph", fit_narrative_fit_score: 2 });
    expect(draftFitStillFresh({ fitScore: 2, grantIntelligence: "the original paragraph" }, c, grant())).toBe(false);
  });

  it("a legacy draft with no snapshotted signature reads STALE (regenerates into the new format)", () => {
    expect(draftFitStillFresh({}, card({ fit_score: 3, fit_narrative: "x", fit_narrative_fit_score: 3 }), grant())).toBe(false);
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

// The eligibility HARD-KILL pin, folded into #570 from the roadmap page (both review bots flagged the
// alert showing an un-pinned score). With FIT_NARRATIVE_ENABLED on, a structurally-ineligible grant (a
// skip_reason / structural note — computeEligibility's ONLY `ineligible` trigger, never a keyword miss)
// pins the DISPLAYED alert fit to 1 so the client-facing fit-score block reads no-go exactly as the
// console/portal do. The write side (buildAlertData) and the freshness side (draftStillFresh) apply the
// SAME pin, so a pinned draft still reads FRESH — no infinite regeneration. Flag OFF is byte-identical.
describe("eligibility hard-kill pin (FIT_NARRATIVE_ENABLED)", () => {
  const withFlag = <T>(on: boolean, fn: () => T): T => {
    const prev = process.env.FIT_NARRATIVE_ENABLED;
    process.env.FIT_NARRATIVE_ENABLED = on ? "true" : "false";
    try {
      return fn();
    } finally {
      if (prev === undefined) delete process.env.FIT_NARRATIVE_ENABLED;
      else process.env.FIT_NARRATIVE_ENABLED = prev;
    }
  };
  // computeEligibility reports `ineligible` ONLY on a structural note / skip_reason (client-independent).
  const ineligible = grant({ skip_reason: "Single national award to one intermediary; sub-grants only." });
  const eligible = grant({ skip_reason: null });
  const strong = card({ fit_score: 3, fit_narrative: "an affirmative paragraph", fit_narrative_fit_score: 3 });

  it("flag ON + structurally-ineligible grant → displayed fit PINNED to 1 (Weak)", () => {
    withFlag(true, () => {
      expect(alertFitSignature(strong, ineligible).fitScore).toBe(1);
      const d = buildAlertData(ineligible, strong, null);
      expect(d.fitScore).toBe(1);
      expect(d.fitScoreLabel).toBe("Weak");
      // The narrative still rides — the client keeps its rationale, matching the client-side report page.
      expect(d.grantIntelligence).toBe("an affirmative paragraph");
    });
  });

  it("flag ON + ELIGIBLE grant (no skip_reason) → no pin", () => {
    withFlag(true, () => {
      expect(alertFitSignature(strong, eligible).fitScore).toBe(3);
      expect(buildAlertData(eligible, strong, null).fitScoreLabel).toBe("Strong fit");
    });
  });

  it("flag OFF → byte-identical, no pin even on an ineligible grant", () => {
    withFlag(false, () => {
      expect(alertFitSignature(strong, ineligible).fitScore).toBe(3);
      expect(buildAlertData(ineligible, strong, null).fitScore).toBe(3);
    });
  });

  it("write side and freshness side apply the SAME pin → a pinned draft reads FRESH (no infinite regen)", () => {
    withFlag(true, () => {
      const stored = buildAlertData(ineligible, strong, null); // the snapshot pins fitScore → 1
      expect(stored.fitScore).toBe(1);
      expect(draftStillFresh(stored, { card: strong, grant: ineligible, isLead: false })).toBe(true);
    });
  });
});
