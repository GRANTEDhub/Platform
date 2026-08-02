import type { FactorRating, FactorScores } from "@/types/database";

// The six fit factors as the grant-review screen reads them.
//
// RATING IS SEGMENT COUNT, NOT HUE (see RATING in lib/brand.ts). The previous build ran
// green / gold / red side by side, distinguishable only by the one channel a red-green
// viewer cannot use. Three segments, N filled, and the word underneath — legible to
// everyone and it survives being printed in greyscale.
//
// EXACTLY ONE ROW LIGHTS. The screen's whole argument is that this grant is capped for
// one reason, and the eye should find that reason without reading. Lighting every weak
// factor would make a highlight into a background. So `lead` is the single worst factor
// and everything else renders neutral — but `weakCount` reports the truth, so the copy
// can say "and two others" rather than the page quietly implying there is only one.

export type FactorKey = keyof FactorScores;

// Staff wording, and the order the review screen lists them in. Deliberately NOT
// FACTOR_LABELS from lib/report/shape.ts: those are worded for a client reading their own
// Grant Report ("Track record", "Match / budget"), and this surface is the analyst's.
export const REVIEW_FACTORS: { key: FactorKey; label: string }[] = [
  { key: "seat_role", label: "Seat / role fit" },
  { key: "eligibility", label: "Eligibility" },
  { key: "mission", label: "Mission alignment" },
  { key: "cost_share", label: "Match / cost-share" },
  { key: "geographic", label: "Geographic fit" },
  { key: "program_history", label: "Program history" },
];

// How many of three segments a rating fills, and what it is called.
//
// `insufficient_data` fills NONE and is never called "weak". Not knowing and knowing it
// is bad are different facts, and collapsing them would let a card scored before a factor
// existed read as a finding about the client.
const SEGMENTS: Record<FactorRating, { filled: number; word: string; rank: number }> = {
  strong: { filled: 3, word: "Strong", rank: 3 },
  moderate: { filled: 2, word: "Moderate", rank: 2 },
  weak: { filled: 1, word: "Weak", rank: 1 },
  insufficient_data: { filled: 0, word: "Not assessed", rank: 0 },
};

export interface ReviewFactor {
  key: FactorKey;
  label: string;
  rating: FactorRating | null;
  filled: number;
  word: string;
  // The engine's own sentence for this factor. On the lead factor this IS the blocking
  // sentence the rationale paragraph bolds.
  rationale: string | null;
  // The one row allowed to light orange.
  lead: boolean;
}

export interface FitFactorView {
  factors: ReviewFactor[];
  // The single worst factor, or null when nothing is below strong (or nothing is scored).
  lead: ReviewFactor | null;
  // How many factors are weak or unassessed, INCLUDING the lead. The copy needs this to
  // avoid implying the lead is the only problem when it is not.
  weakCount: number;
  // True when the card predates per-factor scoring entirely (#105).
  unscored: boolean;
}

export function viewFitFactors(scores: FactorScores | null): FitFactorView {
  const factors: ReviewFactor[] = REVIEW_FACTORS.map(({ key, label }) => {
    const rating = scores?.[key]?.rating ?? null;
    const seg = rating ? SEGMENTS[rating] : null;
    return {
      key,
      label,
      rating,
      filled: seg?.filled ?? 0,
      word: seg?.word ?? "Not assessed",
      rationale: scores?.[key]?.rationale?.trim() || null,
      lead: false,
    };
  });

  // Worst first; REVIEW_FACTORS order breaks ties, so the pick is stable across renders
  // and two equally-weak factors always resolve the same way.
  const rankOf = (f: ReviewFactor) => (f.rating ? SEGMENTS[f.rating].rank : Number.POSITIVE_INFINITY);
  const scored = factors.filter((f) => f.rating !== null);
  const worst = scored.reduce<ReviewFactor | null>(
    (acc, f) => (acc === null || rankOf(f) < rankOf(acc) ? f : acc),
    null,
  );

  // Nothing lights when the whole set is strong: there is no blocker to point at, and an
  // orange row on a clean card would invent one.
  const lead = worst && worst.rating !== "strong" ? worst : null;
  if (lead) lead.lead = true;

  return {
    factors,
    lead,
    weakCount: scored.filter((f) => f.rating === "weak" || f.rating === "insufficient_data").length,
    unscored: scored.length === 0,
  };
}
