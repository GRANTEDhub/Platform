import { format } from "date-fns";
import { formatAwardRange, compactCostShare, formatDeadline } from "@/lib/grants/format";
import { sanitizeRichText, sanitizeText } from "@/lib/sanitize/html";
import type { Grant, ReviewCard } from "@/types/database";
import type { AlertData, AlertEnrichment, AlertStat } from "./types";

// Assemble the template data object. FACTS are deterministic (schema + format.ts,
// never the model); NARRATIVE comes from the validated enrichment, with safe
// fallbacks so a thin/failed enrichment still yields a valid alert, never broken.

function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// "Jul 8" when the deadline parses; else a trimmed raw token for the stat tile.
function shortDeadline(raw: string | null | undefined): string {
  const s = (raw ?? "").trim();
  if (!s) return "TBD";
  const d = new Date(s);
  if (!isNaN(d.getTime()) && /\d{4}/.test(s)) return format(d, "MMM d");
  return s.length > 12 ? s.slice(0, 12) : s;
}

function fiscalYear(g: Grant): string {
  const src = (g.submission_deadline || g.ingested_at || "").toString();
  const m = src.match(/(20\d{2})/);
  return m ? `FY${m[1]}` : "";
}

// Sanitize the description (it may carry HTML markup -- whitelist p/strong/em/ul/
// ol/li/br, everything else stripped) so the client never sees raw tags in the
// alert PDF, then linkify the funder name to the source URL if both are present
// and the name appears in the copy (a safe post-sanitize substitution).
function buildIntroHtml(g: Grant, card: ReviewCard): string {
  const raw = (card.description_short || g.description || "").trim();
  if (!raw) return sanitizeText(g.title || "A new grant opportunity was published.");
  const clean = sanitizeRichText(raw);
  const funder = (g.funder || "").trim();
  if (funder && g.source_url) {
    const fEnc = sanitizeText(funder);
    if (fEnc && clean.includes(fEnc)) {
      const link = `<a href="${sanitizeText(g.source_url)}" style="color:#b3541e;font-weight:600;text-decoration:underline;text-underline-offset:2px;">${fEnc}</a>`;
      return clean.replace(fEnc, link);
    }
  }
  return clean;
}

function stripTrailingPunct(s: string): string {
  return s.replace(/\s*[.;,]+\s*$/, "");
}
function truncateWords(s: string, n: number): string {
  const t = s.trim();
  return t.length <= n ? t : t.slice(0, n).replace(/\s+\S*$/, "") + "…";
}

// Deterministic fallback for "who can apply" (used only if the LLM summary is
// absent). Kept tight: dedupe trailing punctuation (avoids "in that state..") and
// truncate a long ineligible dump so it stays readable.
function buildEligibilityHtml(g: Grant): string {
  const parts: string[] = [];
  const types = (g.eligible_entity_types ?? []).map((t) => t.replace(/_/g, " "));
  if (types.length > 0) {
    const geo = g.geographic_eligibility ? ` in ${stripTrailingPunct(g.geographic_eligibility)}` : "";
    parts.push(`${stripTrailingPunct(types.join(", "))}${geo}.`);
  } else if (g.geographic_eligibility) {
    parts.push(`Eligible in ${stripTrailingPunct(g.geographic_eligibility)}.`);
  }
  if (g.ineligible_entities) parts.push(`Not eligible: ${stripTrailingPunct(truncateWords(g.ineligible_entities, 140))}.`);
  return esc(parts.join(" ") || "See the NOFO for full eligibility.");
}

// A concise award-count for the stat cell. num_awards is often verbose ("Up to
// 56 awards (one per state...); 10 in round 1, ...") -- extract a short token so
// it can't blow out the fixed stat band; the full detail goes to the footnote.
function shortAwards(raw: string): string {
  const s = raw.trim();
  const num = s.match(/\d[\d,]*/);
  if (!num) return s.length > 12 ? `${s.slice(0, 12).trim()}…` : s;
  const before = s.slice(0, num.index ?? 0).toLowerCase();
  if (/\bup to\b/.test(before)) return `Up to ${num[0]}`;
  if (/(about|around|approx|~|≈)/.test(before)) return `~${num[0]}`;
  return num[0];
}

// Deterministic stats, deadline last + highlighted; cap at 4. Per-field bounding
// (NOT a blanket char cap, which would clip a legitimately wide award range like
// "$10.5M – $100.5M"): the only free-text field is num_awards -> shortAwards();
// award range/match/deadline come pre-bounded from their formatters. The
// template's nowrap/ellipsis is the visual safety net for any residual overflow.
function buildStats(g: Grant): AlertStat[] {
  const stats: AlertStat[] = [];
  const award = formatAwardRange(g.award_range_min, g.award_range_max);
  if (award !== "—") stats.push({ value: award, label: g.award_range_is_estimate ? "award · est." : "award range" });
  const cs = compactCostShare(g.cost_share);
  if (cs === "None") stats.push({ value: "$0", label: "match required" });
  else if (cs !== "—") stats.push({ value: cs.length > 8 ? cs.slice(0, 8) : cs, label: "match" });
  if (stats.length < 3 && g.num_awards) stats.push({ value: shortAwards(g.num_awards), label: "awards" });
  stats.push({ value: shortDeadline(g.submission_deadline), label: "deadline", highlight: true });
  return stats.slice(-4); // keep the deadline (last) if we overflow
}

export function buildAlertData(g: Grant, card: ReviewCard, enrich: AlertEnrichment | null): AlertData {
  const funder = (g.funder || "").trim();
  const incumbentFallback = g.incumbent_risk
    ? { label: "The make-or-break factor", headline: "", body: g.incumbent_risk }
    : null;

  // When the award-count is verbose, the stat cell shows a short token and the
  // full detail moves to the footnote under the stat band (rather than overrun).
  const awardsFull = (g.num_awards || "").trim();
  const awardsFootnote = awardsFull && shortAwards(awardsFull) !== awardsFull ? awardsFull : null;

  return {
    // ── narrative (model, with fallbacks) ──
    headline: enrich?.headline?.trim() || g.title || "New grant opportunity",
    alertLabel: enrich?.alertLabel?.trim() || (funder ? `${funder} Alert` : "GRANTED Alert"),
    programShort: enrich?.programShort?.trim() || "",
    whatItFundsIntro: enrich?.whatItFundsIntro?.trim() || "What this grant funds:",
    whatItFunds: enrich?.whatItFunds?.length ? enrich.whatItFunds : (g.focus_areas ?? []),
    ctaSendItems: enrich?.ctaSendItems?.trim() || "your organization's priorities and any relevant history",
    riskCallout: enrich?.riskCallout ?? incumbentFallback,

    // Clean program name from the model; raw funder is the fallback.
    programName: enrich?.programName?.trim() || funder || "Federal grant program",

    // ── facts (deterministic) ──
    fiscalYear: fiscalYear(g),
    fon: g.fon || null,
    introHtml: buildIntroHtml(g, card),
    stats: buildStats(g),
    statsFootnote: awardsFootnote,
    // Concise, grounded eligibility from the model; deterministic tight fallback.
    eligibilityHtml: enrich?.eligibilitySummary?.trim()
      ? esc(enrich.eligibilitySummary.trim())
      : buildEligibilityHtml(g),
    // Short note from the model; else truncate the raw note to fit the compact box.
    eligibilityNote:
      enrich?.eligibilityNote ??
      (g.ideal_applicant_profile?.eligibility_note
        ? { label: "Eligibility note", body: truncateWords(g.ideal_applicant_profile.eligibility_note, 180) }
        : null),
    // No structured state-passthrough data in the schema -> federal-direct default.
    statePassThrough: false,
    deadlineLong: formatDeadline(g.submission_deadline),
  };
}

// Short plain-text email body that accompanies the PDF (facts only).
export function buildAlertEmailBody(g: Grant, card: ReviewCard): string {
  const award = formatAwardRange(g.award_range_min, g.award_range_max);
  const deadline = formatDeadline(g.submission_deadline);
  const funds = (card.description_short || g.description || "").trim();
  const fundsLine = funds ? ` It funds ${funds.replace(/\s+/g, " ").slice(0, 160).replace(/[.,;]\s*$/, "")}.` : "";
  const awardLine = award !== "—" ? ` Award ${award}.` : "";
  const deadlineLine = deadline !== "—" ? ` Deadline ${deadline}.` : "";
  return [
    `${g.title || "A grant"} was published.${fundsLine}${awardLine}${deadlineLine}`,
    "",
    "The full alert is attached as a one-page PDF.",
    "",
    "— GRANTED",
  ].join("\n");
}
