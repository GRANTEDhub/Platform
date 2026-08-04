import { format } from "date-fns";
import { formatAwardRange, compactCostShare, formatDeadline } from "@/lib/grants/format";
import { sanitizeRichText, sanitizeText } from "@/lib/sanitize/html";
import { PROSPECT_CREDENTIAL } from "./copy";
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
// Cut at the last SENTENCE end before `max`, falling back to the last word boundary. A
// hard slice mid-word reads as a truncation bug rather than an excerpt, and mid-sentence
// reads as missing content.
export function clampAtSentence(raw: string, max: number): string {
  const s = raw.replace(/\s+/g, " ").trim();
  if (s.length <= max) return s;
  const head = s.slice(0, max);
  const stop = Math.max(head.lastIndexOf(". "), head.lastIndexOf("? "), head.lastIndexOf("! "));
  if (stop > max * 0.55) return head.slice(0, stop + 1);
  const space = head.lastIndexOf(" ");
  return `${head.slice(0, space > 0 ? space : max).replace(/[,;:]$/, "")}…`;
}

// THE HERO DESCRIPTION. Grant-level, never client-level.
//
// It used to build from card.description_short, extended with grants.description when
// thin. description_short is written by the matcher (engine.ts, protected) and is
// CLIENT-SLANTED -- "UAMS NorthWest applies as prime to disburse SDS scholarships..." --
// so the hero read as a second concept proposal sitting directly above the real concept
// box, and the box below it was the only one of the two that was actually a concept.
// description_brief (migration 0069, lib/grants/brief.ts) is the plain-language
// paraphrase of what the PROGRAM funds, shared with the console and portal detail pages,
// so all three now describe the grant the same way and none of them pre-empts the
// concept.
//
// INTRO_MAX still clamps: the brief runs up to ~250 words for a detail page, and the hero
// is sized to ~2 sentences at 14.5px across the 700px measure. Over that it drives the
// stat strip down and the alert stops being one letter page. Clamping a clean paraphrase
// on a sentence boundary yields a good opening; clamping the old merge did not.
// BOTH RAISED, and the whitespace is why. Pinning the decision band to the bottom of the
// letter page (grant-alert-client.hbs) left the page's slack in one visible gap between the
// concept grid and the band. The answer is to spend that space on CONTENT rather than
// redistribute it: a fuller hero and a fuller concept box both grow into the gap, and the
// band stays where it belongs. These are ceilings, not targets -- a genuinely short grant
// still renders short, and the band simply sits lower.
//
// Still bounded, because the alert is ONE letter page and always must be. INTRO_MAX is
// sized to ~3-4 sentences at 14.5px across the 700px measure; CONCEPT_MAX to the taller
// of the two grid columns. Raising either much further starts pushing the stat strip and
// then the band off the page, which is the failure these constants exist to prevent.
const CONCEPT_MAX = 620;
const INTRO_MAX = 520;

function introSource(g: Grant): string {
  const brief = (g.description_brief || "").trim();
  return clampAtSentence(brief || (g.description || "").trim(), INTRO_MAX);
}

function buildIntroHtml(g: Grant): string {
  const raw = introSource(g);
  if (!raw) return sanitizeText(g.title || "A new grant opportunity was published.");
  const clean = sanitizeRichText(raw);
  const funder = (g.funder || "").trim();
  if (funder && g.source_url) {
    const fEnc = sanitizeText(funder);
    if (fEnc && clean.includes(fEnc)) {
      const link = `<a href="${sanitizeText(g.source_url)}" style="color:#E4761F;font-weight:600;text-decoration:underline;text-underline-offset:2px;">${fEnc}</a>`;
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

// A concise award-count for the stat cell. num_awards is free text from grant
// extraction, often verbose ("Up to 56 awards (one per state...); 10 in round 1,
// ...") -- extract a short token so it can't blow out the fixed stat band; the
// full detail goes to the footnote. A bounded RANGE ("1-3", "10 to 20") is
// preserved as "1–3" rather than collapsed to its first number.
function shortAwards(raw: string): string {
  const s = raw.trim();
  const range = s.match(/(\d[\d,]*)\s*(?:-|–|—|to)\s*(\d[\d,]*)/i);
  if (range) return `${range[1]}–${range[2]}`;
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
  // Share the web pages' rule verbatim (grant-detail.tsx GrantStatBand): "None"
  // for no cost share, else the clean amount -- compactCostShare strips trailing
  // "match"/"cost share" wording, since the "match required" label already says it.
  // No hard slice (it clipped mid-number, e.g. "$150,000" -> "$150,000 "); the
  // template's ellipsis is the backstop for any pathologically long value.
  const cs = compactCostShare(g.cost_share);
  if (cs !== "—") stats.push({ value: cs, label: "match required" });
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
  // full detail moves to the footnote. Only when there's genuinely MORE detail
  // than the stat conveys (long free text) -- a short "1-3 awards" needs no
  // redundant footnote.
  const awardsFull = (g.num_awards || "").trim();
  const awardsFootnote =
    awardsFull.length > 24 && shortAwards(awardsFull) !== awardsFull ? awardsFull : null;

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
    introHtml: buildIntroHtml(g),
    // CLAMPED FOR THE LAYOUT, not for the scorer -- the concept box is a fixed column in a
    // two-up grid, and past ~7 lines it drives the whole grid taller and pushes the decision
    // band off the page. 400 is real headroom (a typical synopsis runs ~290), so this bites
    // rarely rather than constantly. A limit can only fix overflow; short text still leaves
    // whitespace, which the grid's height:100% absorbs.
    conceptSynopsis: clampAtSentence((card.concept_synopsis || "").trim(), CONCEPT_MAX) || null,
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

// The deterministic grant-announcement sentence shared by the client and prospect
// email bodies: title + a trimmed funds clause + award + deadline. Facts only, so
// both surfaces announce the grant identically.
function grantAnnouncement(g: Grant): string {
  const award = formatAwardRange(g.award_range_min, g.award_range_max);
  const deadline = formatDeadline(g.submission_deadline);
  // Same grant-level source as the PDF hero, for the same reason: this renders as
  // "It funds <clause>", and description_short turned that into "It funds UAMS NorthWest
  // applies as prime to disburse SDS scholarships" -- a concept proposal wearing a
  // description's grammar.
  const funds = (g.description_brief || g.description || "").trim();
  // Bound the funds clause to keep the announcement short, but cut on a WORD
  // boundary (truncateWords), never mid-word -- a hard slice(0, 160) clipped
  // "coding" to "codi". When truncated the trailing "…" signals it; otherwise
  // close the clause with a period (stripping any trailing punctuation first).
  const fundsText = truncateWords(funds.replace(/\s+/g, " "), 160);
  const fundsLine = funds
    ? ` It funds ${fundsText.endsWith("…") ? fundsText : `${stripTrailingPunct(fundsText)}.`}`
    : "";
  const awardLine = award !== "—" ? ` Award ${award}.` : "";
  const deadlineLine = deadline !== "—" ? ` Deadline ${deadline}.` : "";
  return `${g.title || "A grant"} was published.${fundsLine}${awardLine}${deadlineLine}`;
}

// Short plain-text email body that accompanies the PDF for a CLIENT alert: a
// salutation, a static lead-in transition (never LLM-generated), the shared grant
// announcement, then a PDF pointer and a clean close. No em dashes; no intro or
// credential block -- clients already know us (those are prospect-only, see
// buildProspectEmailBody). Close matches the prospect sign-off.
export function buildAlertEmailBody(g: Grant, card: ReviewCard, portalUrl?: string | null): string {
  const url = (portalUrl ?? "").trim();
  return [
    "Hello,",
    "",
    "A new opportunity came through that may be a fit:",
    "",
    grantAnnouncement(g),
    "",
    // The PDF first (it needs no sign-in), the portal second. Before this the alert
    // offered ONLY the attachment, so a client who wanted to act had to open a PDF and
    // then find the grant themselves -- while the hand-written release note, sent from the
    // same screen, linked them straight into it. Two emails about the same grant, one with
    // a way through and one without.
    url
      ? "The full alert is attached as a one-page PDF. You can also review it and record your decision in your portal:"
      : "The full alert is attached as a one-page PDF.",
    ...(url ? [url] : []),
    "",
    "Best,",
    "GRANTED",
  ].join("\n");
}

// The static cold-outreach credential block lives in ./copy (PROSPECT_CREDENTIAL),
// shared byte-identically with the batch cold composer.

// Plain-text body for a PROSPECT (cold-outreach) alert: salutation, a one-line
// intro naming the sender, the shared grant announcement, the static credential
// block, then a close pointing to the attached PDF. Constraints: plain text, no
// em dashes, no signature block (the rich HTML signature is the deferred part of
// #81). `senderFirstName` is null when we can't resolve a real first name -> a
// name-less intro (never an email/username as a name), and the sign-off carries no
// sender name by design (avoids reading like a signature). `hasSchedulingLink`
// mirrors the PDF: the booking link is baked in only when its token minted, so we
// only promise "a link to schedule a call" when the attached PDF actually carries
// one -- otherwise the email would over-promise. Client alerts get none of this
// -- see buildAlertEmailBody.
export function buildProspectEmailBody(
  g: Grant,
  card: ReviewCard,
  senderFirstName: string | null,
  hasSchedulingLink: boolean,
  followUp = false,
  // Optional one-line teaser from an internally-generated concept proposal. A HOOK
  // (never the full concept), woven in to spark a conversation. Editable in the send
  // modal like the rest of the body. Omitted when there's no concept.
  conceptHook: string | null = null,
): string {
  const name = senderFirstName?.trim();
  // Cold = first-contact intro naming the sender + the firm credential block below.
  // FOLLOW-UP (we've emailed this person before) drops BOTH the first-contact intro
  // and the credential -- re-introducing the firm to a known contact is the exact
  // "we don't track our own outreach" problem the gate exists to prevent. It reads as
  // a continuation, keeping the grant + booking CTA. No decision either way (lead).
  const intro = followUp
    ? "Following up with another opportunity that looks like a strong fit for your organization."
    : name
      ? `I'm ${name} with GRANTED. I came across a grant that looks like a strong fit for your organization and wanted to flag it.`
      : `I'm reaching out from GRANTED. I came across a grant that looks like a strong fit for your organization and wanted to flag it.`;
  const pdfLine = hasSchedulingLink
    ? "The full alert, including a link to schedule a call, is attached as a one-page PDF."
    : "The full alert is attached as a one-page PDF.";
  const lines = ["Hello,", "", intro, "", grantAnnouncement(g), ""];
  if (conceptHook?.trim()) lines.push(`One idea to explore: ${conceptHook.trim()}`, ""); // teaser hook, editable
  if (!followUp) lines.push(PROSPECT_CREDENTIAL, ""); // first-contact credential; dropped on a follow-up
  lines.push(pdfLine, "", "Best,", "GRANTED");
  return lines.join("\n");
}
