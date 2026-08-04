// Data model for the grant-alert one-pager. Mirrors the tokens in
// lib/alerts/template/grant-alert.hbs (see field-mapping.md). FACTUAL fields are
// filled deterministically from the grant/review schema; NARRATIVE fields come
// from the LLM enrichment (AlertEnrichment) and are shape-validated.

import type { ForecastHorizonItem } from "@/lib/grants/forecast-relevance";

export type AlertStat = { value: string; label: string; highlight?: boolean };
export type AlertRiskCallout = { label: string; points?: string; headline: string; body: string };
export type AlertEligibilityNote = { label: string; body: string };

// The tokens the model may write. It never emits raw numbers/dates; the eligibility
// fields are shaped from (and must stay faithful to) the read-only facts it's given.
export interface AlertEnrichment {
  headline: string;
  alertLabel: string;
  programName: string;        // clean human program name (not the raw funder org)
  programShort: string;
  whatItFundsIntro: string;
  whatItFunds: string[];
  eligibilitySummary: string; // concise "who can apply", grounded on the facts
  eligibilityNote: AlertEligibilityNote | null; // short nuance note, or null
  ctaSendItems: string;
  riskCallout: AlertRiskCallout | null;
}

// The full object handed to the template.
export interface AlertData {
  alertLabel: string;
  programName: string;
  programShort: string;
  fiscalYear: string;
  fon: string | null;
  headline: string;
  introHtml: string;
  statePassThrough: boolean;
  state?: string;
  administeringAgency?: string;
  stats: AlertStat[];
  statsFootnote?: string | null;
  whatItFundsIntro: string;
  whatItFunds: string[];
  eligibilityHtml: string;
  eligibilityNote?: AlertEligibilityNote | null;
  riskCallout?: AlertRiskCallout | null;
  ctaSendItems: string;
  deadlineLong: string;
  // Prospect alerts only: a /go/<token> booking link, baked into the PDF's CTA
  // block as a clickable link. Minted at draft-render time (see store.ts) so the
  // saved PDF carries it (preview == sent). Absent on client alerts.
  schedulingUrl?: string | null;
  // Forecasted "On the horizon" section (single-send v1). Computed for client/lead
  // drafts and FROZEN here on first single-send view (preview == sent). Present ==
  // computed; `forecastHorizon: []` means nothing plausibly connected (no page 2).
  // `horizonStoragePath`, when set, points at the separately-rendered horizon page in
  // the same bucket -- concatenated onto the alert ONLY at single-send assembly, never
  // baked into the per-card PDF, so the batch merge is unaffected. Absent on discovery-
  // prospect drafts (no client row) and batch-prepared drafts (horizon is single-only).
  forecastHorizon?: ForecastHorizonItem[];
  horizonStoragePath?: string | null;
  // ACCOUNT-MANAGED CLIENT ALERTS ONLY: the one-click Interested / Not-for-us links.
  // Minted at draft time and frozen here, like schedulingUrl, so the preview shows the
  // exact URLs that go out (preview == sent). Absent on a standard-client alert -- that
  // send records decision='approved' on their behalf, so there is nothing left to ask --
  // and absent on prospect/lead alerts, which have no card decision to record.
  decisionUrls?: { interested: string; pass: string } | null;
  // CLIENT template only. The matcher's concept_synopsis, clamped for the layout, and the
  // portal deep link the "Your call" band points at. Absent on the prospect/lead template,
  // which has no concept to show and no portal to send anyone to.
  conceptSynopsis?: string | null;
  portalUrl?: string | null;
}
