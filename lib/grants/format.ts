import { format } from "date-fns";
import type { Grant } from "@/types/database";

// Shared grant-detail formatting, used by both the Matches review Grant tab
// (/review/[id]) and the Prospects grant detail (/intel/[id]) so the two render
// identical numbers/labels from one source.

// A currency-ish string as a NUMBER of dollars, or null when there is no figure in it
// ("Varies", "See NOFO", ""). Split out of abbrevAmount so that anything summing award
// data — the dashboard's per-stage rollups — parses it exactly the way the display path
// does, rather than growing a second regex that drifts.
export function parseAmount(raw: string | null | undefined): number | null {
  if (!raw) return null;
  const s = raw.trim();
  if (!s) return null;
  const m = s.replace(/,/g, "").match(/\$?\s*([0-9]+(?:\.[0-9]+)?)\s*([kmb])?/i);
  if (!m) return null;
  let n = parseFloat(m[1]);
  const unit = (m[2] || "").toLowerCase();
  if (unit === "k") n *= 1e3;
  else if (unit === "m") n *= 1e6;
  else if (unit === "b") n *= 1e9;
  return Number.isFinite(n) ? n : null;
}

// Compact a dollar figure to $150K / $1.1M.
export function abbrevDollars(n: number): string {
  if (n >= 1e9) return `$${(n / 1e9).toFixed(1).replace(/\.0$/, "")}B`;
  if (n >= 1e6) return `$${(n / 1e6).toFixed(1).replace(/\.0$/, "")}M`;
  if (n >= 1e3) return `$${Math.round(n / 1e3)}K`;
  return `$${Math.round(n)}`;
}

// Compact a currency-ish string to $150K / $1.1M so a range fits one line. Falls
// back to the raw string when it is not numeric (e.g. "Varies").
export function abbrevAmount(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const s = raw.trim();
  if (!s) return null;
  const n = parseAmount(s);
  return n === null ? s : abbrevDollars(n);
}

export function formatAwardRange(min: string | null | undefined, max: string | null | undefined): string {
  const lo = abbrevAmount(min);
  const hi = abbrevAmount(max);
  if (!lo && !hi) return "—";
  if (lo && hi) return `${lo} – ${hi}`;
  return (lo || hi)!;
}

export function compactCostShare(raw: string | null | undefined): string {
  const s = (raw ?? "").trim();
  if (!s) return "—";
  if (/^(none|no\b|not required|n\/?a|\$?0\b|0%)/i.test(s)) return "None";
  // Unknown / unspecified is not a value (the API's is_cost_sharing=null path
  // writes "Not specified") -> show a dash rather than a long phrase.
  if (/^(not specified|unspecified|unknown|tbd|to be determined)\b/i.test(s)) return "—";
  // Prefer a real figure: strip trailing "match" / "cost share" / "required" /
  // "non-federal" wording; if a number/percent/ratio remains, that IS the value.
  const stripped = s
    .replace(/(?:[\s,;:.()\-]*\b(?:cost[-\s]?shar(?:e|ing)|match(?:ing)?|required|non-?federal)\b)+[\s.)]*$/i, "")
    .trim();
  if (stripped && /[\d%]/.test(stripped)) return stripped;
  // Required but with no figure in the source (the Grants.gov/Simpler API exposes
  // only a boolean is_cost_sharing, which engine.ts writes as "Cost sharing
  // required"): show "Required · TBD" -- a match IS required but the specific amount
  // isn't in our data (verify in the NOFO). Deliberately NOT "None" (that would
  // falsely tell a client no match is needed), and short enough to fit the hero tile
  // and the PDF stat cell without wrapping/clipping. Genuinely other free-text
  // (e.g. "Varies") is kept verbatim.
  if (/\b(cost[-\s]?shar|match|required|mandatory|yes)\b/i.test(s)) return "Required · TBD";
  return s;
}

// "March 15, 2026" when it parses as a real date; verbatim otherwise ("Rolling").
export function formatDeadline(raw: string | null | undefined): string {
  const s = (raw ?? "").trim();
  if (!s) return "—";
  const d = new Date(s);
  if (!isNaN(d.getTime()) && /\d{4}/.test(s)) return format(d, "MMMM d, yyyy");
  return s;
}

// Compact deadline ("Sep 15, 2026") for the NARROW hero stat tile, where a full
// month name ("September 15, 2026", 18 chars) would wrap. Same verbatim fallback
// as formatDeadline for non-dates. Only the hero uses this; every other surface
// (prospects body, ledger, PDF) keeps the full-month formatDeadline.
export function formatDeadlineShort(raw: string | null | undefined): string {
  const s = (raw ?? "").trim();
  if (!s) return "—";
  const d = new Date(s);
  if (!isNaN(d.getTime()) && /\d{4}/.test(s)) return format(d, "MMM d, yyyy");
  return s;
}

// Budget one-liner for the Ideal Applicant Profile: award range, plus a match
// note when a real cost share is on file.
export function idealBudget(
  g: Pick<Grant, "award_range_min" | "award_range_max" | "cost_share"> | null | undefined,
): string | null {
  const award = formatAwardRange(g?.award_range_min, g?.award_range_max);
  const cs = compactCostShare(g?.cost_share);
  const hasFigure = /[\d%]/.test(cs);
  // No award: only a real match figure is worth a budget line on its own.
  if (award === "—") return hasFigure ? cs : null;
  if (cs === "—" || cs === "None") return award;
  // "20%" -> "· 20% match"; the figureless "Yes" -> "· match required".
  return `${award} · ${hasFigure ? `${cs} match` : "match required"}`;
}

// Substantive risks only: hard disqualifiers + technical-burden flags always;
// from verification_flags drop imperative boilerplate. Capped to stay scannable.
export type Risk = { tone: "hard" | "warn"; text: string };
function isBoilerplate(s: string): boolean {
  return /^(verify|re-?verify|confirm|check|double|ensure|review|validate)\b/i.test(s.trim());
}
export function collectRisks(
  g: Pick<Grant, "hard_disqualifiers" | "technical_burden_flags" | "verification_flags"> | null | undefined,
): Risk[] {
  return [
    ...(g?.hard_disqualifiers ?? []).map((t): Risk => ({ tone: "hard", text: t })),
    ...(g?.technical_burden_flags ?? []).map((t): Risk => ({ tone: "warn", text: t })),
    ...(g?.verification_flags ?? []).filter((t) => !isBoilerplate(t)).map((t): Risk => ({ tone: "warn", text: t })),
  ]
    .filter((r) => r.text?.trim())
    .slice(0, 6);
}

// Scoring rubric = TOP-LEVEL categories + points only. Drop nested/object values
// (sub-criteria breakdowns) entirely so it reads the same whether a grant has 4
// categories or 20; the caller caps the count. Point value from a number or a
// short "40 pts"/"40 points"/"25%" token; else the category shows with no points.
export function rubricRows(rubric: Record<string, unknown> | null | undefined): { name: string; points: string }[] {
  return Object.entries(rubric ?? {})
    .filter(([k, v]) => k?.trim() && v !== null && typeof v !== "object")
    .map(([name, v]) => {
      let points = "";
      if (typeof v === "number") points = `${v} pts`;
      else {
        const s = String(v).trim();
        const exact = s.match(/^(\d+(?:\.\d+)?)\s*(pts?|points?|%)?$/i);
        if (exact) points = /%/.test(s) ? s : `${exact[1]} pts`;
        else {
          const embedded = s.match(/(\d+)\s*(?:points?|pts?)/i);
          if (embedded) points = `${embedded[1]} pts`;
        }
      }
      return { name, points };
    });
}

// A grant, stated as facts, for a surface that has nothing else on screen to explain
// it -- the "Score a grant" fit check, where the grant may be one the reader has never
// seen. The card pages get their facts from GrantBody/GrantStatTiles; this is the same
// numbers reduced to a serializable payload an API route can hand a client component.
//
// Estimate labelling follows the hero tiles: "Award range · est." when the ledger says
// the figure was inferred rather than published (org rule -- award amounts are labelled
// as estimates, never asserted).
export interface GrantFactSummary {
  description: string | null;
  facts: { label: string; value: string }[];
  focusAreas: string[];
  eligibleEntities: string[];
  sourceUrl: string | null;
  grantStatus: string | null;
}

type SummaryFields = Pick<
  Grant,
  | "description" | "funder" | "fon" | "source_url" | "grant_status"
  | "award_range_min" | "award_range_max" | "award_range_is_estimate"
  | "num_awards" | "cost_share" | "submission_deadline" | "period_of_performance"
  | "focus_areas" | "eligible_entity_types" | "geographic_eligibility"
>;

// Cut long NOFO prose at a sentence boundary where there is one nearby, else at a word
// boundary. A hard slice mid-word reads as a truncation bug rather than an excerpt.
function excerpt(raw: string | null | undefined, max = 700): string | null {
  const s = (raw ?? "").replace(/\s+/g, " ").trim();
  if (!s) return null;
  if (s.length <= max) return s;
  const head = s.slice(0, max);
  const stop = head.lastIndexOf(". ");
  if (stop > max * 0.6) return head.slice(0, stop + 1);
  const space = head.lastIndexOf(" ");
  return `${head.slice(0, space > 0 ? space : max)}…`;
}

export function grantFactSummary(g: SummaryFields): GrantFactSummary {
  const award = formatAwardRange(g.award_range_min, g.award_range_max);
  const cs = compactCostShare(g.cost_share);
  const facts: { label: string; value: string }[] = [
    { label: "Funder", value: g.funder || "—" },
    { label: `Award range${g.award_range_is_estimate ? " · est." : ""}`, value: award },
    { label: "Match required", value: cs },
    { label: "Deadline", value: formatDeadline(g.submission_deadline) },
  ];
  if (g.num_awards) facts.push({ label: "Est. awards", value: g.num_awards });
  if (g.period_of_performance) facts.push({ label: "Project period", value: g.period_of_performance });
  if (g.fon) facts.push({ label: "Opportunity no.", value: g.fon });
  if (g.geographic_eligibility) facts.push({ label: "Geography", value: g.geographic_eligibility });

  return {
    description: excerpt(g.description),
    facts,
    focusAreas: (g.focus_areas ?? []).filter((s) => s?.trim()).slice(0, 8),
    eligibleEntities: (g.eligible_entity_types ?? []).filter((s) => s?.trim()).slice(0, 8),
    sourceUrl: g.source_url,
    grantStatus: g.grant_status,
  };
}
