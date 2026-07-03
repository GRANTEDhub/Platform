// Hand-maintained types mirroring supabase/migrations/0001_init.sql.
// Regenerate with `supabase gen types typescript` once the CLI is wired up.

export type UserRole = "admin" | "contractor";

export interface Profile {
  id: string;
  email: string | null;
  full_name: string | null;
  role: UserRole;
  created_at: string;
  updated_at: string;
}

// Hard, code-enforced client constraints (migration 0018). These are the
// "a miss is unacceptable" gates (legal / eligibility), enforced deterministically
// in code rather than left to the model as advisory matching_rules prose.
//   ineligible_funder  -> excluded pre-model (never scored)
//   role_ceiling       -> post-model clamp: cap the role (and score)
//   ineligible_partner -> post-model clamp: block the structured prime + force a flag
//   entity_screen      -> guaranteed before_you_approve flag (content-dependent; not a silent exclude)
export type ConstraintType =
  | "ineligible_funder"
  | "role_ceiling"
  | "ineligible_partner"
  | "entity_screen";
export type ConstraintAction = "exclude" | "cap_role" | "flag";
export interface HardConstraint {
  type: ConstraintType;
  value: string; // funder name | ceiling role | partner org | screen subject
  scope?: string; // optional: only applies to grants matching this (heuristic match)
  action: ConstraintAction;
  note: string; // human-readable; also injected into the prompt so model + code agree
}

// A discovered non-client org surfaced by the Track 2 prospect engine
// (migration 0019). source_url is non-null by schema: the structural
// hallucination guard -- a prospect with no real source cannot exist.
export interface Prospect {
  id: string;
  name: string;
  org_type: string | null;
  location_state: string | null;
  location_county: string | null;
  source_url: string;
  capability_summary: string | null;
  created_at: string;
}

export interface Client {
  id: string;
  name: string;
  org_type: string | null;
  status: string;
  engagement_tier: string | null;
  primary_contact_name: string | null;
  primary_contact_email: string | null;
  primary_contact_phone: string | null;
  location_city: string | null;
  location_county: string | null;
  location_state: string | null;
  service_area: string[] | null;
  retainer_hours: number | null;
  contract_start: string | null;
  contract_end: string | null;
  next_step: string | null;
  notes: string | null;
  // Grant-matching profile (Phase 3). Non-financial; readable by contractors.
  rucc_codes: string | null;
  annual_budget: string | null;
  primary_funding_needs: string[] | null;
  project_stage: string | null;
  match_cost_share_capacity: string | null;
  federal_grant_history: string | null;
  // USASpending lookup overrides (migration 0015). search_name: query this
  // instead of `name` when set. verified: suppress the live lookup and treat
  // the stored federal_grant_history as authoritative.
  usaspending_search_name: string | null;
  federal_history_verified: boolean;
  // Cached USASpending result (migration 0024) so matching reads stored data
  // instead of calling the API live mid-match. Structured USASpendingResult;
  // formatted at read time. Fetched at intake + a monthly cron sweep.
  usaspending_summary: Record<string, unknown> | null;
  usaspending_checked_at: string | null;
  sam_uei_status: string | null;
  // Structured SAM.gov registration (migration 0023). Compliance/readiness only,
  // NOT read by the matcher. Populated via the human-confirmed resolve flow.
  uei: string | null;
  sam_matched_name: string | null;
  sam_registration_status: string | null;
  sam_expiration_date: string | null;
  sam_checked_at: string | null;
  known_constraints: string | null;
  // Client-specific authoritative matching overrides (editable; read by the
  // engine and applied before general logic). See migration 0008.
  matching_rules: string | null;
  // Hard, code-enforced constraints (migration 0018). Structured gates that the
  // engine enforces in code (not advisory prose): supersede matching_rules for
  // the cases they cover. Null/absent = none.
  hard_constraints: HardConstraint[] | null;
  // Lead pipeline (migration 0025). A lead is a clients row with pipeline_stage
  // set; null = a real client that never entered the pipeline. Converted =
  // pipeline_stage='converted' AND status='active' (same row, zero migration).
  // Stored pipeline_stage holds only human stages + 'converted'; derived stages
  // are computed in lib/leads/stage.ts. See isUnconvertedLead() before including
  // clients rows in matcher/roster queries (they bypass RLS via the service role).
  pipeline_stage: string | null;
  lead_source: string | null;
  account_manager_id: string | null;
  intake_data: Record<string, unknown> | null;
  needs_review: boolean;
  archived_reason: string | null;
  contract_status: string | null;
  contract_signed_at: string | null;
  unsubscribed_at: string | null;
  created_at: string;
  updated_at: string;
}

// A grant-match hook: the scored fit that grounds warm outreach, snapshotted
// durably onto a lead (migration 0025). One row per (lead, grant); a lead
// accrues more as new grants fit. Provenance ids are nullable (prospect rows and
// their cards are non-durable, so the snapshot columns are authoritative).
export interface LeadGrantHook {
  id: string;
  client_id: string;
  grant_id: string | null;
  prospect_id: string | null;
  review_card_id: string | null;
  fit_score: number | null;
  proposed_role: string | null;
  recommended_prime: string | null;
  why_snapshot: string[] | null;
  concept_snapshot: string | null;
  created_at: string;
}

// Stage A (Step 3): the grant's ideal applicant/consortium, constructed from the
// full NOFO independent of our roster. Multi-archetype: a grant can legitimately
// support 1-3 distinct prime shapes (county vs nonprofit vs IHE leading from
// different angles). Clients map onto a SEAT in this profile, and the seat sets
// the score ceiling.
export interface ApplicantArchetype {
  label: string;
  ideal_prime_shape: string;
  core_role: string;
  partner_seats: string[];
}

export interface IdealApplicantProfile {
  core_funded_role: string;
  summary: string;
  archetypes: ApplicantArchetype[];
  eligibility_note?: string;
}

export interface Grant {
  id: string;
  source_url: string | null;
  funder: string | null;
  fon: string | null;
  title: string | null;
  description: string | null;
  total_funding: string | null;
  award_range_min: string | null;
  award_range_max: string | null;
  award_range_is_estimate: boolean | null;
  num_awards: string | null;
  submission_deadline: string | null;
  deadline: string | null;
  period_of_performance: string | null;
  cost_share: string | null;
  eligible_entity_types: string[] | null;
  geographic_eligibility: string | null;
  ineligible_entities: string | null;
  focus_areas: string[] | null;
  scoring_rubric: Record<string, unknown> | null;
  program_type: string | null;
  delivery_model: string | null;
  grant_status: string | null;
  // Forecasted -> active lifecycle marker (migration 0021). Set once, at the
  // moment the cron detects a grant we ingested as Forecasted has flipped to
  // posted and re-shreds/re-matches it. Null = never activated from a forecast.
  activated_from_forecast_at: string | null;
  scoring_criteria_high_value: string[] | null;
  technical_burden_flags: string[] | null;
  incumbent_risk: string | null;
  subaward_prohibited: boolean | null;
  verification_flags: string[] | null;
  hard_disqualifiers: string[] | null;
  raw_text: string | null;
  status: string;
  error_detail: string | null;
  // Grant-level skip reason for the Ledger (migration 0020). Set at the pre-shred
  // grant-level gate (e.g. single national award). Null = not a grant-level skip;
  // international / hard-disqualifier reasons derive from is_domestic /
  // hard_disqualifiers instead. Disposition is derived, never stored.
  skip_reason: string | null;
  is_domestic: boolean;
  // Step 2: 'full' = parsed from the real program NOFO; 'summary' = API summary
  // only (with shred_reason explaining why the deep shred wasn't available).
  shred_depth: "full" | "summary";
  shred_reason: string | null;
  // Step 3 / Stage A: the grant's ideal applicant/consortium (multi-archetype).
  ideal_applicant_profile: IdealApplicantProfile | null;
  ingested_at: string;
}

export type CardDecision = "pending" | "approved" | "passed";

export interface ReviewCard {
  id: string;
  grant_id: string | null;
  client_id: string | null;
  fit_score: 1 | 2 | 3;
  proposed_role: string | null;
  recommended_prime: string | null;
  why_this_org: string[] | null;
  concept_synopsis: string | null;
  description_short: string | null;
  draft_outreach_email: string | null;
  // Human-approved/edited body that will be sent. Separate from the AI draft
  // above so the original is preserved (see migration 0007).
  final_outreach_email: string | null;
  outreach_track: string | null;
  before_you_approve: string[] | null;
  inferred_fields: string[] | null;
  reasoning_context: {
    eligibility_analysis?: string;
    fit_score_derivation?: string;
    role_assignment_logic?: string;
    consortium_rationale?: string;
    concept_derivation?: string;
    why_not_others?: string;
  } | null;
  // Track 2 discriminator (migration 0019). 'client' (default) or 'prospect'.
  // The client-first gate counts only client cards; a prospect card must never
  // enter the lock/release computation. prospect_id is set on prospect cards.
  card_type: string;
  prospect_id: string | null;
  decision: CardDecision;
  // RETIRED: the Hold decision was removed (workflow is approve / pass / leave
  // pending). These columns (0002 hold_reason, 0017 hold_category) are no longer
  // written or read -- kept unused, not dropped, to preserve any historical note.
  hold_reason: string | null;
  hold_category: string | null;
  // Reason captured when a match is rejected (Pass).
  decision_reason: string | null;
  decided_by: string | null;
  decided_at: string | null;
  // Send tracking. Populated by the (not-yet-built) send step.
  sent_at: string | null;
  sent_to: string | null;
}

// One row per (grant, client) scoring attempt — the engine's observability log.
// review_cards holds only qualifying matches; this holds every outcome.
export interface MatchAttempt {
  id: string;
  grant_id: string | null;
  client_id: string | null;
  outcome: "carded" | "below_threshold" | "suppressed" | "disqualified" | "prefiltered" | "error";
  fit_score: number | null;
  suppressed: boolean;
  suppress_reason: string | null;
  disqualified: boolean;
  disqualify_reason: string | null;
  prefilter_reason: string | null;
  error_detail: string | null;
  result: Record<string, unknown> | null;
  created_at: string;
}

// Append-only analyst QA judgment on a match (the calibration dataset). Keyed on
// the stable grant+client identity; provenance pointers are nullable so feedback
// survives re-scores. Snapshots the engine's state at feedback time.
export interface MatchFeedback {
  id: string;
  grant_id: string | null;
  client_id: string | null;
  review_card_id: string | null;
  match_attempt_id: string | null;
  agree: boolean;
  corrected_score: number | null;
  reason: string | null;
  engine_score: number | null;
  engine_seat_ref: string | null;
  engine_reasoning: Record<string, unknown> | null;
  created_by: string | null;
  created_at: string;
}

export interface ClientOverview {
  id: string;
  name: string;
  org_type: string | null;
  status: string;
  engagement_tier: string | null;
  contract_end: string | null;
  next_step: string | null;
  retainer_hours: number | null;
  hours_logged: number;
  hours_remaining: number;
  owed_cents: number;
  next_deadline: string | null;
  pipeline_stage: string | null; // migration 0026 — lets the dashboard exclude leads
}

export interface TimeEntry {
  id: string;
  client_id: string;
  user_id: string | null;
  work_date: string;
  hours: number;
  description: string | null;
  billable: boolean;
  created_at: string;
}

export interface Invoice {
  id: string;
  client_id: string;
  amount_cents: number;
  status: string;
  issued_date: string | null;
  due_date: string | null;
  paid_date: string | null;
  stripe_invoice_id: string | null;
  notes: string | null;
  created_at: string;
  updated_at: string;
}

// Minimal placeholder so the generic Supabase client type-checks. The grant
// tables are fleshed out in the grant-intelligence phase.
export interface Database {
  public: {
    Tables: {
      profiles: { Row: Profile; Insert: Partial<Profile>; Update: Partial<Profile>; Relationships: [] };
      clients: { Row: Client; Insert: Partial<Client>; Update: Partial<Client>; Relationships: [] };
      time_entries: { Row: TimeEntry; Insert: Partial<TimeEntry>; Update: Partial<TimeEntry>; Relationships: [] };
      invoices: { Row: Invoice; Insert: Partial<Invoice>; Update: Partial<Invoice>; Relationships: [] };
    };
    Views: {
      client_overview: { Row: ClientOverview; Relationships: [] };
    };
    Functions: Record<string, never>;
    Enums: { user_role: UserRole };
    CompositeTypes: Record<string, never>;
  };
}
