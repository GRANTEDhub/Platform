// Shared view-model for the Grant Report — the client-facing "roadmap" surface.
// One shaping layer feeds BOTH the client portal and (later) the staff account-
// manager view, so the two render identically off the same decision data
// (review_cards + the joined grant). Pure + presentation-agnostic: no JSX here,
// just the derived shape and the small honest formatters the rows/detail need.
import type { CardDecision, FactorRating, FactorScores, Grant, ReviewCard } from "@/types/database";
import { formatAwardRange, formatDeadlineShort } from "@/lib/grants/format";

export type FactorKey = keyof FactorScores;

// Client-legible labels for the engine's six sub-scores. Same factors staff see;
// worded for a client audience.
export const FACTOR_LABELS: Record<FactorKey, string> = {
  mission: "Mission fit",
  eligibility: "Eligibility",
  geographic: "Geographic",
  seat_role: "Role fit",
  program_history: "Track record",
  cost_share: "Match / budget",
};

// Order the detail renders the full breakdown in. The compact list row shows the
// first three (the most client-legible signals); the rest live in the detail.
export const ALL_FACTORS: FactorKey[] = [
  "mission",
  "eligibility",
  "geographic",
  "seat_role",
  "program_history",
  "cost_share",
];
export const ROW_FACTORS: FactorKey[] = ["mission", "eligibility", "geographic"];

export interface FitBand {
  label: string;
  // Ring/label tone; mapped to brand classes by the renderer.
  tone: "strong" | "good" | "fair";
}

// Fit is the engine's 1–3 ordinal — never a percentage. Labels match the staff
// review bands so client and account manager read the same word for the same score.
export const FIT_BAND: Record<1 | 2 | 3, FitBand> = {
  3: { label: "Strong fit", tone: "strong" },
  2: { label: "Conditional", tone: "good" },
  1: { label: "Weak", tone: "fair" },
};

export interface FactorView {
  key: FactorKey;
  label: string;
  rating: FactorRating | null; // null = card scored before per-factor sub-scores shipped
  rationale: string | null;
}

// Mark + tone for a factor rating. Data only (tailwind class strings) so both the
// client-side list and the server-side detail render it without duplicating logic.
export function factorDisplay(rating: FactorRating | null): {
  mark: "check" | "approx" | "dash";
  className: string;
  word: string;
} {
  switch (rating) {
    case "strong":
      return { mark: "check", className: "text-emerald-600", word: "Strong" };
    case "moderate":
      return { mark: "approx", className: "text-amber-500", word: "Moderate" };
    case "weak":
      return { mark: "approx", className: "text-brand-orange", word: "Limited" };
    default:
      return { mark: "dash", className: "text-muted-foreground", word: "Not yet assessed" };
  }
}

export function factorViews(scores: FactorScores | null, keys: FactorKey[] = ALL_FACTORS): FactorView[] {
  return keys.map((key) => {
    const fs = scores?.[key] ?? null;
    return {
      key,
      label: FACTOR_LABELS[key],
      rating: fs?.rating ?? null,
      rationale: fs?.rationale ?? null,
    };
  });
}

// Whole days until the deadline (negative once past). null when the date is
// rolling / TBD / unparseable — mirrors the grant-detail sublabel logic.
export function deadlineDaysLeft(raw: string | null | undefined): number | null {
  const s = (raw ?? "").trim();
  if (!s || !/\d{4}/.test(s)) return null;
  const d = new Date(s);
  if (isNaN(d.getTime())) return null;
  return Math.ceil((d.getTime() - Date.now()) / 86_400_000);
}

export interface ReportItem {
  id: string; // review_card id — the link target
  grantId: string | null;
  title: string;
  funder: string | null;
  fitScore: 1 | 2 | 3;
  band: FitBand;
  role: string | null; // proposed_role (Prime / Partner) — a real prime-vs-partner signal
  focusAreas: string[];
  awardRange: string;
  awardIsEstimate: boolean;
  deadlineLabel: string;
  deadlineDaysLeft: number | null;
  deadlineSoon: boolean; // within 30 days (and not past)
  decision: CardDecision;
  rowFactors: FactorView[];
}

// The columns the list needs off each joined review_card. A fuller select is
// structurally assignable, so callers can over-select freely.
export type ReportCardRow = Pick<
  ReviewCard,
  "id" | "grant_id" | "fit_score" | "proposed_role" | "decision" | "factor_scores"
> & {
  grants: Pick<
    Grant,
    "title" | "funder" | "submission_deadline" | "award_range_min" | "award_range_max" | "award_range_is_estimate" | "focus_areas"
  > | null;
};

export function toReportItem(card: ReportCardRow): ReportItem {
  const g = card.grants;
  const days = deadlineDaysLeft(g?.submission_deadline);
  const fit = (card.fit_score ?? 1) as 1 | 2 | 3;
  return {
    id: card.id,
    grantId: card.grant_id,
    title: g?.title || "Untitled opportunity",
    funder: g?.funder ?? null,
    fitScore: fit,
    band: FIT_BAND[fit] ?? FIT_BAND[1],
    role: card.proposed_role,
    focusAreas: (g?.focus_areas ?? []).slice(0, 2),
    awardRange: formatAwardRange(g?.award_range_min, g?.award_range_max),
    awardIsEstimate: !!g?.award_range_is_estimate,
    deadlineLabel: formatDeadlineShort(g?.submission_deadline),
    deadlineDaysLeft: days,
    deadlineSoon: days !== null && days >= 0 && days <= 30,
    decision: card.decision,
    rowFactors: factorViews(card.factor_scores, ROW_FACTORS),
  };
}

// Rank: strongest fit first, then soonest real deadline (rolling/TBD sink to the
// bottom), then title for a stable order.
export function toReportItems(cards: ReportCardRow[]): ReportItem[] {
  return cards.map(toReportItem).sort((a, b) => {
    if (b.fitScore !== a.fitScore) return b.fitScore - a.fitScore;
    const ad = a.deadlineDaysLeft, bd = b.deadlineDaysLeft;
    if (ad !== bd) {
      if (ad === null) return 1;
      if (bd === null) return -1;
      return ad - bd;
    }
    return a.title.localeCompare(b.title);
  });
}

export interface ReportStats {
  matched: number;
  avgFit: string | null; // one-decimal string, e.g. "2.7"; null when empty
  dueSoon: number; // deadline within 30 days
}

export function reportStats(items: ReportItem[]): ReportStats {
  const matched = items.length;
  const avg = matched ? items.reduce((s, i) => s + i.fitScore, 0) / matched : null;
  return {
    matched,
    avgFit: avg === null ? null : avg.toFixed(1),
    dueSoon: items.filter((i) => i.deadlineSoon).length,
  };
}
