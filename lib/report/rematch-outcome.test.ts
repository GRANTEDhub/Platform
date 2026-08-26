import { describe, it, expect } from "vitest";
import { classifyRematch } from "./rematch-outcome";

// Deterministic unit test for the one shared classifier. Each case maps a (card-state,
// attempt-row) shape scoreGrantClientPair can leave behind to the outcome the route and
// button both render from. Order matters: prefilter/error are checked BEFORE the
// card-existence branch, because an unchanged card must not read as "refreshed".

const base = {
  storedFitScore: 3 as number | null,
  cardStillExists: true,
  attemptOutcome: "carded" as string | null,
  freshFitScore: 3 as number | null,
  suppressReason: null as string | null,
  disqualifyReason: null as string | null,
  prefilterReason: null as string | null,
  errorDetail: null as string | null,
};

describe("classifyRematch", () => {
  it("refreshed, no drift: same score, card survived", () => {
    const out = classifyRematch({ ...base, storedFitScore: 3, freshFitScore: 3 });
    expect(out).toEqual({ kind: "refreshed", storedFitScore: 3, freshFitScore: 3, drifted: false });
  });

  it("refreshed, drifted: score moved but still qualifies", () => {
    const out = classifyRematch({ ...base, attemptOutcome: "carded", storedFitScore: 3, freshFitScore: 2 });
    expect(out).toEqual({ kind: "refreshed", storedFitScore: 3, freshFitScore: 2, drifted: true });
  });

  it("dropped: card gone, uses the disqualify reason first", () => {
    const out = classifyRematch({
      ...base,
      cardStillExists: false,
      attemptOutcome: "disqualified",
      storedFitScore: 2,
      freshFitScore: 0,
      disqualifyReason: "Entity type ineligible (Gate 2).",
      suppressReason: "some suppression",
    });
    expect(out).toEqual({ kind: "dropped", storedFitScore: 2, reason: "Entity type ineligible (Gate 2)." });
  });

  it("dropped: card gone, falls back to the suppress reason when not disqualified", () => {
    const out = classifyRematch({
      ...base,
      cardStillExists: false,
      attemptOutcome: "suppressed",
      storedFitScore: 2,
      freshFitScore: 1,
      suppressReason: "Single national award — no realistic prime path.",
    });
    expect(out).toEqual({ kind: "dropped", storedFitScore: 2, reason: "Single national award — no realistic prime path." });
  });

  it("dropped: card gone with no reason (bare below_threshold) states it plainly", () => {
    const out = classifyRematch({
      ...base,
      cardStillExists: false,
      attemptOutcome: "below_threshold",
      storedFitScore: 2,
      freshFitScore: 1,
    });
    expect(out).toEqual({ kind: "dropped", storedFitScore: 2, reason: "it no longer scores high enough to surface" });
  });

  it("prefiltered: card left UNCHANGED, reported as prefiltered even though the card still exists", () => {
    const out = classifyRematch({
      ...base,
      cardStillExists: true, // the pre-filter path never touches the card
      attemptOutcome: "prefiltered",
      prefilterReason: "Low award count (5 expected, < 10) — not surfaced for org_type \"local_government\".",
    });
    expect(out).toEqual({
      kind: "prefiltered",
      reason: "Low award count (5 expected, < 10) — not surfaced for org_type \"local_government\".",
    });
  });

  it("prefiltered: with no reason string, a plain default", () => {
    const out = classifyRematch({ ...base, attemptOutcome: "prefiltered", prefilterReason: null });
    expect(out).toEqual({ kind: "prefiltered", reason: "this grant is now pre-filtered for this client" });
  });

  it("error: scoring threw, card untouched — reported as error, never as refreshed", () => {
    const out = classifyRematch({
      ...base,
      attemptOutcome: "error",
      errorDetail: "Scoring failed: model timeout",
    });
    expect(out).toEqual({ kind: "error", detail: "Scoring failed: model timeout" });
  });

  it("error takes precedence over the card-existence branch", () => {
    // Even if the card happens to be gone, an 'error' attempt must not be read as 'dropped'.
    const out = classifyRematch({ ...base, cardStillExists: false, attemptOutcome: "error", errorDetail: "boom" });
    expect(out).toEqual({ kind: "error", detail: "boom" });
  });
});
