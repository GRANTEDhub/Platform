// Lead pipeline stage — the two-layer model. pipeline_stage (stored) holds only
// human-judgment positions + terminal 'converted'; the further-along DERIVED
// positions (discovery_scheduled, contracting, payment_pending, paid) are
// computed here at read time from events / contracts / invoices, so every
// surface reads ONE effective stage. Same derived-state discipline as the
// client-first gate and the grant disposition -- no stored status flag to drift.

// Values that may be STORED in clients.pipeline_stage (enforced by the DB CHECK
// in migration 0025). Human-judgment stages + the terminal 'converted'.
export type StoredStage =
  | "outbound_new"
  | "new"
  | "contacted"
  | "quoted"
  | "pending"
  | "archived"
  | "converted";

// The full set a lead can effectively occupy, including derived positions that
// are NEVER stored.
export type EffectiveStage =
  | "outbound_new"
  | "new"
  | "contacted"
  | "discovery_scheduled"
  | "quoted"
  | "pending"
  | "contracting"
  | "payment_pending"
  | "paid"
  | "converted"
  | "archived";

// Durable signals a caller derives from pipeline_events / clients.contract_* /
// invoices. All optional so partially-built phases pass only what exists yet.
export interface LeadSignals {
  booked?: boolean; // a discovery-call booking event exists
  contractStarted?: boolean; // contract drafted/sent (contract_status set)
  contractSigned?: boolean; // clients.contract_signed_at is set
  invoiceIssued?: boolean; // an invoice exists but is not paid
  invoicePaid?: boolean; // an invoice is paid
  converted?: boolean; // pipeline_stage='converted' AND status='active'
}

// Funnel order; higher = further along. 'archived' is a terminal EXIT, off-ladder.
const RANK: Record<EffectiveStage, number> = {
  outbound_new: 0,
  new: 1,
  contacted: 2,
  discovery_scheduled: 3,
  quoted: 4,
  pending: 5,
  contracting: 6,
  payment_pending: 7,
  paid: 8,
  converted: 9,
  archived: -1,
};

// THE single source of truth for "where is this lead?". Effective stage = the
// FURTHEST-along position implied by the stored human stage OR any durable
// signal -- signals only auto-ADVANCE, they never regress a human's stored
// position. Terminal exit (archived) and terminal completion (converted) win
// outright. Returns null for a non-lead row (pipeline_stage is null).
export function effectiveStage(
  stored: StoredStage | null,
  signals: LeadSignals = {},
): EffectiveStage | null {
  if (stored === null) return null; // not a lead
  if (stored === "archived") return "archived"; // explicit exit; no signal un-archives
  if (signals.converted || stored === "converted") return "converted";

  const candidates: EffectiveStage[] = [stored];
  if (signals.booked) candidates.push("discovery_scheduled");
  if (signals.contractStarted || signals.contractSigned) candidates.push("contracting");
  if (signals.invoiceIssued) candidates.push("payment_pending");
  if (signals.invoicePaid) candidates.push("paid");

  return candidates.reduce((best, s) => (RANK[s] > RANK[best] ? s : best), candidates[0]);
}

// A row is an UN-CONVERTED lead iff it entered the pipeline and hasn't graduated.
// Mirrors the clients RLS SELECT predicate. Use it to EXCLUDE leads from client /
// roster / matching queries, which run under the service role and BYPASS RLS
// (runMatching, dashboards, the clients list). Critical: without this filter the
// matcher would score grants against leads.
export function isUnconvertedLead(pipelineStage: string | null | undefined): boolean {
  return pipelineStage != null && pipelineStage !== "converted";
}
