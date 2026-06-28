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
  sam_uei_status: string | null;
  known_constraints: string | null;
  created_at: string;
  updated_at: string;
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
  scoring_criteria_high_value: string[] | null;
  technical_burden_flags: string[] | null;
  incumbent_risk: string | null;
  subaward_prohibited: boolean | null;
  verification_flags: string[] | null;
  raw_text: string | null;
  status: string;
  error_detail: string | null;
  is_domestic: boolean;
  ingested_at: string;
}

export type CardDecision = "pending" | "approved" | "passed" | "hold";

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
  decision: CardDecision;
  hold_reason: string | null;
  decided_by: string | null;
  created_at: string;
  decided_at: string | null;
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
