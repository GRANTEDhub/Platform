// Lead pipeline stage — the two-layer sales-pipeline model. The four ordered
// stages are: discovery_pending -> contract_pending -> contract_signed ->
// invoice_paid, then CONVERT (status='active' + pipeline_stage='converted').
// Only discovery_pending (the entry stage) + the side/terminal states are STORED;
// the contract_* and invoice_paid positions are DERIVED at read time from the
// contracts table + payment, so every surface reads ONE effective stage. Same
// derived-state discipline as the client-first gate -- no stored flag to drift.
//
// Intake and discovery-booking are FLAGS, not stages (rendered as badges); they
// never gate the stage. Side states rejected/archived are off-ladder (rank -1).

// Values that may be STORED in clients.pipeline_stage (DB CHECK, migration 0032).
// The entry stage, the two off-ladder side states, and the terminal 'converted'.
export type StoredStage =
  | "discovery_pending"
  | "rejected"
  | "archived"
  | "converted";

// The full set a lead can effectively occupy, including derived positions that
// are NEVER stored (contract_pending, contract_signed, invoice_paid).
export type EffectiveStage =
  | "discovery_pending"
  | "contract_pending"
  | "contract_signed"
  | "invoice_paid"
  | "converted"
  | "rejected"
  | "archived";

// Durable signals a caller derives from the contracts table / payment. All
// optional so partially-built phases pass only what exists yet. Contract signals
// come from the contracts table (source of truth), not the clients mirror.
export interface LeadSignals {
  contractPending?: boolean; // a contract exists in draft/sent (not yet signed)
  contractSigned?: boolean; // a contract is signed
  invoicePaid?: boolean; // payment received (dark until P5)
  converted?: boolean; // pipeline_stage='converted' AND status='active'
}

// Funnel order; higher = further along. rejected/archived are terminal EXITs,
// off-ladder.
const RANK: Record<EffectiveStage, number> = {
  discovery_pending: 0,
  contract_pending: 1,
  contract_signed: 2,
  invoice_paid: 3,
  converted: 4,
  rejected: -1,
  archived: -1,
};

// THE single source of truth for "where is this lead?". Effective stage = the
// FURTHEST-along position implied by the stored entry stage OR any durable signal
// -- signals only auto-ADVANCE, never regress. Terminal exits (rejected/archived)
// and terminal completion (converted) win outright. Returns null for a non-lead
// row (pipeline_stage is null).
export function effectiveStage(
  stored: StoredStage | null,
  signals: LeadSignals = {},
): EffectiveStage | null {
  if (stored === null) return null; // not a lead
  if (stored === "archived") return "archived"; // explicit exit; no signal un-archives
  if (stored === "rejected") return "rejected"; // explicit exit
  if (signals.converted || stored === "converted") return "converted";

  const candidates: EffectiveStage[] = [stored];
  if (signals.contractPending) candidates.push("contract_pending");
  if (signals.contractSigned) candidates.push("contract_signed");
  if (signals.invoicePaid) candidates.push("invoice_paid");

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

// PostgREST `.or()` fragment expressing "NOT an un-converted lead" -- the query
// mirror of isUnconvertedLead(). Use it on any service-role read of clients /
// client_overview that must NOT include leads (runMatching, the roster list, the
// dashboard). Kept beside the helper so the two definitions never drift.
// Requires pipeline_stage to be selectable on the queried relation (it is on
// clients since 0025 and on client_overview since 0026).
export const NON_LEAD_OR_FILTER = "pipeline_stage.is.null,pipeline_stage.eq.converted";
