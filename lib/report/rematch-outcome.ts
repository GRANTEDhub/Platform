// What a single-card re-match actually did, classified from the DB state AFTER
// scoreGrantClientPair ran. ONE tested source of truth shared by the route (to shape
// its JSON response) and the RematchCard button (to render the right sentence), so the
// two can never describe the same re-score differently.
//
// scoreGrantClientPair (lib/grants/pipeline.ts) is the persist-safely primitive we reuse
// verbatim. Its four possible effects on a PENDING card map to the four outcomes here:
//   - the pair pre-filters now  -> it returns early, records a 'prefiltered' attempt, and
//     leaves the card UNCHANGED (a now-excluded pair is not the same as a dropped one).
//   - scoring throws            -> it records an 'error' attempt and leaves the card as-is.
//   - the pair still qualifies   -> it refreshes the card in place (score may have DRIFTED).
//   - the pair no longer qualifies (below_threshold / suppressed / disqualified) -> it
//     DELETES the pending card. This is the engine's own surface threshold, not a QA
//     removal — the "never auto-removes" rule is a QA-layer property, and a plain engine
//     re-score dropping a card it no longer scores >=2 is exactly what the roster re-match
//     already does.
//
// Determined without trusting any single signal: `cardStillExists` (re-read of the card)
// decides dropped-vs-refreshed, and the attempt row supplies the reason and the reason-code.

export type RematchOutcome =
  | { kind: "refreshed"; storedFitScore: number | null; freshFitScore: number | null; drifted: boolean }
  | { kind: "dropped"; storedFitScore: number | null; reason: string }
  | { kind: "prefiltered"; reason: string }
  | { kind: "error"; detail: string };

export function classifyRematch(input: {
  storedFitScore: number | null;
  cardStillExists: boolean;
  // The outcome string on the match_attempts row scoreGrantClientPair just wrote:
  // 'carded' | 'below_threshold' | 'suppressed' | 'disqualified' | 'prefiltered' | 'error' | null.
  attemptOutcome: string | null;
  // The fresh fit_score — from the surviving card, or (if dropped/unchanged) the attempt.
  freshFitScore: number | null;
  suppressReason: string | null;
  disqualifyReason: string | null;
  prefilterReason: string | null;
  errorDetail: string | null;
}): RematchOutcome {
  // Pre-filter and error both leave the card untouched — report them as themselves rather
  // than misreading an unchanged card as "refreshed, no drift".
  if (input.attemptOutcome === "prefiltered") {
    return { kind: "prefiltered", reason: input.prefilterReason ?? "this grant is now pre-filtered for this client" };
  }
  if (input.attemptOutcome === "error") {
    return { kind: "error", detail: input.errorDetail ?? "the scorer failed" };
  }

  // The card is gone -> the re-score dropped it below the surface threshold. Prefer the
  // most specific reason the engine gave (disqualify, then suppress), else a plain statement.
  if (!input.cardStillExists) {
    return {
      kind: "dropped",
      storedFitScore: input.storedFitScore,
      reason:
        input.disqualifyReason ??
        input.suppressReason ??
        "it no longer scores high enough to surface",
    };
  }

  // The card survived and was refreshed in place. Drift = the integer score moved.
  return {
    kind: "refreshed",
    storedFitScore: input.storedFitScore,
    freshFitScore: input.freshFitScore,
    drifted: input.storedFitScore !== input.freshFitScore,
  };
}
