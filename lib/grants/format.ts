import { format } from "date-fns";
import type { Grant } from "@/types/database";

// Shared grant-detail formatting, used by both the Matches review Grant tab
// (/review/[id]) and the Prospects grant detail (/intel/[id]) so the two render
// identical numbers/labels from one source.

// Compact a currency-ish string to $150K / $1.1M so a range fits one line. Falls
// back to the raw string when it is not numeric (e.g. "Varies").
export function abbrevAmount(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const s = raw.trim();
  if (!s) return null;
  const m = s.replace(/,/g, "").match(/\$?\s*([0-9]+(?:\.[0-9]+)?)\s*([kmb])?/i);
  if (!m) return s;
  let n = parseFloat(m[1]);
  const unit = (m[2] || "").toLowerCase();
  if (unit === "k") n *= 1e3;
  else if (unit === "m") n *= 1e6;
  else if (unit === "b") n *= 1e9;
  if (n >= 1e9) return `$${(n / 1e9).toFixed(1).replace(/\.0$/, "")}B`;
  if (n >= 1e6) return `$${(n / 1e6).toFixed(1).replace(/\.0$/, "")}M`;
  if (n >= 1e3) return `$${Math.round(n / 1e3)}K`;
  return `$${Math.round(n)}`;
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

// Budget one-liner for the Ideal Applicant Profile: award range, plus a match
// note when a real cost share is on file.
export function idealBudget(
  g: Pick<Grant, "award_range_min" | "award_range_max" | "cost_share"> | null | undefined,
): string | null {
  const award = formatAwardRange(g?.award_range_min, g?.award_range_max);
  const cs = compactCostShare(g?.cost_share);
  if (award === "—") return cs === "—" ? null : cs;
  return cs !== "—" && cs !== "None" ? `${award} · ${cs} match` : award;
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
