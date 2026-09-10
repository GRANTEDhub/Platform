// Pure classification + key derivation for a detected hit. No I/O — unit-tested directly.
//
// Three jobs:
//   1. classifyItem → is this a grant OPPORTUNITY (promote), a LOAN (record, never promote — decision
//      A), a PDF (flag only — v1), or noise (ignore)? Plus a forecasted flag.
//   2. external_ref / item_hash → the dedup key (so the same opportunity is not re-ingested each run,
//      decision 3) and the change-detection key (so a moved deadline is caught, decision 6).
//   3. buildEligibilityPreamble → the authoritative geo/elig context seeded into the shred input at
//      promotion, so the existing matcher gates geography + applicant type (decision B).

import {
  ELIG_TAG_DESCRIPTIONS,
  GEO_TAG_DESCRIPTIONS,
  type SourceSeed,
  type DocType,
  type EligTag,
  type FundingType,
  type GeoTag,
} from "@/lib/ar-grants/sources";
import { sha256hex, type RawItem } from "@/lib/ar-grants/parse";

// LOANS — the AR Ag SRF/bond family and generic financing language. A loan match ALWAYS wins over a
// grant signal (a "loan grant program" is a loan), so a revolving/SRF product can never be promoted.
const LOAN_KEYWORDS =
  /\b(loan|loans|revolving fund|state revolving|srf|cwsrf|dwsrf|water development fund|\bwdf\b|water, sewer|wssw|\bcgo\b|bond financing|bonds?\b|financing program|low-interest|amortiz)/i;

// GRANT / funding words. NOT sufficient alone to promote (see STRONG_APP_KEYWORDS) — a landing page
// is full of program/nav links carrying these. Used only for the loan-source branch and the
// grant-word-plus-a-deadline branch.
const GRANT_KEYWORDS = /\b(grant|grants|funding|award|awards|matching grant|cost.?share|financial assistance)/i;

// A REAL application signal — explicit intent to accept applications, not just the word "grant". This
// is the precision gate (Shannon 2026-09-10): promote ONLY when a hit shows application language, so
// a program description or a nav link is not mistaken for an open opportunity.
const STRONG_APP_KEYWORDS =
  /\bNOFO\b|\bNOFA\b|\bRFP\b|\bRFA\b|\bRFQ\b|notice of funding|request for (?:proposals|applications|qualifications)|funding opportunit|grant opportunit|call for (?:projects|applications|proposals)|how to apply|apply (?:by|now|online|today|here)\b|\bto apply\b|now accepting|accepting applications|application (?:period|deadline|window|guide|packet|instructions)|applications?\s+(?:\w+\s+){0,2}(?:open|opening|clos|due|accept)|deadline to apply|grant application/i;

// FORECAST — not yet open. A forecasted hit is shredded but HELD (grant_status='Forecasted' →
// pipeline skips matching) until it posts; the change-detection pass flips it when the page opens.
const FORECAST_KEYWORDS =
  /\b(forthcoming|coming soon|anticipated|not yet open|will open|opening soon|upcoming|planned for|to be announced|\btba\b|expected to|check back)/i;

export interface Classified {
  docType: DocType;
  fundingType: FundingType;
  forecasted: boolean;
  geoTag: GeoTag;
  eligTag: EligTag;
}

// Returns a classification, or null when the hit is noise (no funding signal on a link that isn't a
// PDF or a loan). Conservative by design: better to miss a poorly-labelled opportunity (the admin
// dry-run surfaces what was detected) than to promote a nav link as a grant.
export function classifyItem(item: RawItem, source: SourceSeed): Classified | null {
  const hay = `${item.title} ${item.context} ${item.url ?? ""}`;
  const forecasted = FORECAST_KEYWORDS.test(hay);
  const base = { forecasted, geoTag: source.geo_tag, eligTag: source.elig_tag };

  // A PDF link is flagged regardless of funding wording (v1: title + URL only, not parsed).
  if (item.isPdf) {
    return { docType: "pdf", fundingType: loanish(hay) ? "loan" : "grant", ...base };
  }

  // Loan wins outright — the funding-type gate (decision A).
  if (loanish(hay)) return { docType: "loan", fundingType: "loan", ...base };
  // A loan-only source with any funding wording: still a loan.
  if (source.funding_type === "loan" && GRANT_KEYWORDS.test(hay)) {
    return { docType: "loan", fundingType: "loan", ...base };
  }

  // PRECISION over recall (Shannon 2026-09-10): a bare "grant"/"funding" word is NOT enough — landing
  // pages are full of program/nav links carrying it, which flooded the pipeline (16 false
  // opportunities off one AEDC page, eating the whole promote cap). Promote ONLY on a real
  // application signal: explicit application language OR a grant/funding word paired with a concrete
  // deadline. Better to miss a couple and loosen from a clean baseline than to bury the real ones.
  const applicationSignal = STRONG_APP_KEYWORDS.test(hay);
  const grantWithDeadline = GRANT_KEYWORDS.test(hay) && extractDeadlineSignal(item.context) !== "";
  if (applicationSignal || grantWithDeadline) {
    return { docType: "opportunity", fundingType: "grant", ...base };
  }

  return null; // noise — a program/nav link with no application signal
}

function loanish(hay: string): boolean {
  return LOAN_KEYWORDS.test(hay);
}

// A stable slug for the agency, for the external_ref namespace.
export function agencySlug(agency: string): string {
  return agency.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

// external_ref — the dedup key (unique in ar_source_items). A per-item URL is the natural stable key;
// a list-only hit with no URL synthesizes one from a title+deadline hash (decision 3).
export function externalRef(item: RawItem, source: SourceSeed): string {
  const slug = agencySlug(source.agency);
  if (item.url) return `${slug}:${item.url}`;
  return `${slug}:h:${sha256hex(`${item.title}|${extractDeadlineSignal(item.context)}`)}`;
}

// item_hash — the change-detection key. Keyed on title + url + the DEADLINE SIGNAL + the FORECAST
// state, so (a) a moved deadline flips it (decision 6) without a cosmetic edit producing a false
// "changed", and (b) a lifecycle flip from forthcoming → open flips it too even when title/url/
// deadline are unchanged — so the forecasted grant is re-queued and matched when it posts (decision 5,
// the Water & Sewer program). `forecasted` comes from classifyItem, not the RawItem, so it is passed.
export function itemHash(item: RawItem, forecasted: boolean): string {
  return sha256hex(`${item.title}|${item.url ?? ""}|${extractDeadlineSignal(item.context)}|f:${forecasted ? 1 : 0}`);
}

// A STABLE deadline signal from the context: the date(s) plus a bare marker for any deadline keyword
// present — deliberately NOT the trailing prose after "due", so a moved date flips the hash but an
// unrelated edit ("...read more here") does not. Used only inside externalRef / itemHash.
export function extractDeadlineSignal(context: string): string {
  const dateRe =
    /\b(?:january|february|march|april|may|june|july|august|september|october|november|december)\s+\d{1,2}(?:,\s*\d{4})?\b|\b\d{1,2}\/\d{1,2}\/\d{2,4}\b|\b\d{4}-\d{2}-\d{2}\b/gi;
  const dates = (context.match(dateRe) ?? []).map((s) => s.toLowerCase().replace(/\s+/g, " ").trim());
  const markers: string[] = [];
  for (const kw of ["deadline", "due", "apply by", "closes", "closing"]) {
    if (new RegExp(`\\b${kw}\\b`, "i").test(context)) markers.push(kw);
  }
  return [...new Set([...dates, ...markers])].sort().join("|");
}

// The authoritative eligibility preamble prepended to the shred input at promotion. The shredder
// extracts geographic_eligibility + eligible_entity_types from it, so the existing matcher gates them
// (decision B). Labelled clearly as GRANTED-supplied context, distinct from the source document.
export function buildEligibilityPreamble(source: SourceSeed, cls: Classified, detailText: string): string {
  const geo = GEO_TAG_DESCRIPTIONS[cls.geoTag];
  const elig = ELIG_TAG_DESCRIPTIONS[cls.eligTag];
  const forecastLine = cls.forecasted
    ? "\n- STATUS: This program appears to be FORTHCOMING / not yet open for applications. Treat it as forecasted, not currently accepting applications."
    : "";
  return [
    "[GRANTED SOURCE REGISTRY — AUTHORITATIVE ELIGIBILITY CONTEXT]",
    `Captured from ${source.agency} (${source.url}). Per the GRANTED source registry, apply the following as the opportunity's eligibility unless the source text below explicitly states otherwise:`,
    `- ELIGIBLE GEOGRAPHY / SERVICE AREA: ${geo}`,
    `- ELIGIBLE APPLICANT TYPES: ${elig}${forecastLine}`,
    "[END ELIGIBILITY CONTEXT]",
    "",
    detailText,
  ].join("\n");
}
