// Data model for the grant-alert one-pager. Mirrors the tokens in
// lib/alerts/template/grant-alert.hbs (see field-mapping.md). FACTUAL fields are
// filled deterministically from the grant/review schema; NARRATIVE fields come
// from the LLM enrichment (AlertEnrichment) and are shape-validated.

export type AlertStat = { value: string; label: string; highlight?: boolean };
export type AlertRiskCallout = { label: string; points?: string; headline: string; body: string };
export type AlertEligibilityNote = { label: string; body: string };

// The ONLY tokens the model may write. It never emits numbers/dates/eligibility.
export interface AlertEnrichment {
  headline: string;
  alertLabel: string;
  programShort: string;
  whatItFundsIntro: string;
  whatItFunds: string[];
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
}
