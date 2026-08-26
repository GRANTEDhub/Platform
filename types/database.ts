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
//   do_not_surface_for -> post-model SUPPRESS when the grant matches a contraindicated topic
//                         (e.g. a client exiting a service line); recorded reason, overridable
export type ConstraintType =
  | "ineligible_funder"
  | "role_ceiling"
  | "ineligible_partner"
  | "entity_screen"
  | "do_not_surface_for";
export type ConstraintAction = "exclude" | "cap_role" | "flag" | "suppress";
export interface HardConstraint {
  type: ConstraintType;
  value: string; // funder name | ceiling role | partner org | screen subject | contraindicated topic
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
  // Contact for emailing the grant-alert one-pager (set by an admin on the review
  // card; prospects have no contact on discovery). Migration 0036.
  primary_contact_email: string | null;
  primary_contact_name: string | null;
  created_at: string;
}

// Cached IRS Form 990 financials from the ProPublica Nonprofit Explorer (migration
// 0067). Enrichment CITATION only — grounds narrative + flags ("FY22 revenue $X,
// IRS 990"); like usaspending_summary it is NEVER read by the occupancy scorer.
export interface NonprofitFinance {
  ein: string;
  fiscal_year: number | null;
  total_revenue: number | null;
  total_expenses: number | null;
  total_assets: number | null;
  organization_name: string | null;
  source_url: string;
  // true = a real answer was obtained (a filing, OR a confirmed "org has no filings
  // with data"); false is never stored — a failed lookup leaves the prior value and
  // does not advance checked_at, so it retries.
  verified: boolean;
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
  // Street address (migration 0064). Nullable, additive. Powers point-level
  // geocoding (tract GEOID) for the shortage-area / eligibility overlays; the
  // Census Geocoder only resolves a full street address, not a city name.
  location_street: string | null;
  location_zip: string | null;
  service_area: string[] | null;
  retainer_hours: number | null;
  contract_start: string | null;
  contract_end: string | null;
  next_step: string | null;
  notes: string | null;
  // Public site (migration 0063). Captured on the lightweight Add-prospect form;
  // context for the AM + available to enrichment. Nullable, additive.
  website: string | null;
  // Grant-matching profile (Phase 3). Non-financial; readable by contractors.
  rucc_codes: string | null;
  annual_budget: string | null;
  // Org identity + auto-pulled financials (migration 0067). ein is the staff-entered
  // IRS EIN; nonprofit_finance caches the latest IRS Form 990 figures pulled from the
  // ProPublica Nonprofit Explorer. Enrichment CITATION only (never a matcher gate),
  // mirroring the usaspending_summary cache. Refreshed at intake + edit.
  ein: string | null;
  nonprofit_finance: NonprofitFinance | null;
  nonprofit_finance_checked_at: string | null;
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
  // Distilled, match-optimized profile (migration 0043). Populated out-of-band
  // from intake by constructClientProfile. Read ONLY by the enrichment layer
  // (lib/grants/engine.ts enrichMatchWithProfile) to ground the outward narrative
  // -- it does NOT feed occupancy/seat selection (that is grant + rubric + raw
  // fields). Null until refined.
  client_profile: ClientProfile | null;
  // When client_profile was last DISTILLED (0080). Written only by
  // refreshClientProfileById, in the same update as the profile itself. Null on rows
  // distilled before the column existed -- deliberately not backfilled, because no
  // honest value exists for them and this is the one tier of data every consumer is
  // told to doubt. NOT touched by the community-context-only patch, which rewrites the
  // jsonb without re-running the model.
  client_profile_generated_at: string | null;
  // One-time client-centric match progress (migration 0045). Set only for a
  // prospect added via the client form, which ENQUEUES a one-time match against the
  // current grant pool (drained by lib/clients/match-queue.ts): null = never run,
  // 'queued' = awaiting the drain, 'running' = being scored across invocations (the
  // dashboard shows a progress banner + polls), 'complete', 'error'. Active clients
  // stay null (the daily batch covers them).
  initial_match_status: string | null;
  // Concurrency lease for the one-time-match drain (migration 0049): a drain sets
  // this to now() when it claims the record, renews it while scoring, and clears it
  // on a clean stop / terminal state. Other drains skip a record whose lease is
  // still fresh; an expired/null lease is claimable. See lib/clients/match-queue.ts.
  match_locked_at: string | null;
  needs_review: boolean;
  // Research-grants opt-in (migration 0051). Default false. When true, the forecasted
  // "on the horizon" relevance pass includes research funders (NIH) for this client
  // (isResearchExcludedFunder optIn bypass). Surfaced on the client form for
  // small_business / higher_education org types only.
  research_opt_in: boolean;
  // Premium tier gate (migration 0059). When true, an account manager reviews and
  // releases each match (their own Grant Alerts, then Grant Report pass) BEFORE
  // it ever reaches the client's own Grant Alerts. Default false -- the client
  // goes straight to their own two-gate flow, no staff pass in front of it.
  account_managed: boolean;
  archived_reason: string | null;
  contract_status: string | null;
  contract_signed_at: string | null;
  unsubscribed_at: string | null;
  // Flags (migration 0031), not stages: rendered as badges, never gate the stage.
  discovery_booked_at: string | null; // a discovery call is booked
  intake_sent_at: string | null; // an intake form was sent (badge input)
  stripe_customer_id: string | null; // Stripe customer (migration 0033), reused across invoices
  converted_at: string | null; // when the lead converted to an active client (migration 0034)
  // Client-portal seat limit (migration 0055): how many portal logins this client
  // may have. Default 1; staff raise it per the pricing tier.
  seat_limit: number;
  // First-login profile review (migration 0065, #16). Stamped when the client
  // confirms their org profile on the /welcome screen; NULL = not yet confirmed
  // (the portal redirects them to /welcome). Backfilled to now() for clients that
  // were already onboarded (org_type present) so they skip the review.
  profile_confirmed_at: string | null;
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

// Native e-sign contract (P4). Legal/financial record: admin-only RLS; the public
// /sign write path uses the service role gated by a 'lead_sign_contract' token.
export interface Contract {
  id: string;
  client_id: string;
  token_id: string | null;
  template_key: string;
  amount_cents: number | null;
  body_snapshot: string;
  status: "draft" | "sent" | "signed" | "void";
  signer_name: string | null;
  signer_ip: string | null;
  signer_user_agent: string | null;
  signed_at: string | null;
  pdf_url: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
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

// The client-side mirror of IdealApplicantProfile: a distilled, match-optimized
// profile constructed from intake by constructClientProfile (lib/clients/profile.ts).
// Mission/programs/demographics-centered (the priority match signal); prime_capacity
// + supporting_roles + geographic scale carry the prime-vs-partner distinction;
// inferred[]/gaps[] keep it honest (distill, never fabricate). Stored on
// clients.client_profile (migration 0043). NOT read by the matcher in Stage 1.
export interface ClientProgramArea {
  name: string;
  status: "existing" | "prospective";
  description: string;
  target_demographics: string[];
}

export interface ClientProfile {
  summary: string; // 1-2 sentence distilled identity
  mission: string; // distilled mission/purpose -- the priority signal
  core_capabilities: string[]; // funded roles the org can actually perform
  program_areas: ClientProgramArea[];
  populations_served: string[];
  geographic_scope: {
    footprint: string; // e.g. "Northwest Arkansas"
    scale: "local" | "regional" | "statewide" | "multi_state" | "national";
    states: string[];
  };
  // Prime-vs-partner: GENERAL capacity, not a per-grant seat. can_prime is
  // conservative (true only with genuine evidence the org performs a core funded
  // role as its natural function); the matcher still decides the seat per grant.
  prime_capacity: { can_prime: boolean; rationale: string; conditional_on?: string };
  supporting_roles: string[]; // supporting/partner seats it can genuinely fill
  partnerships: string[];
  funding_priorities: string[]; // what they WANT
  fiscal_notes?: { annual_budget?: string; match_capacity?: string; rurality?: string };
  federal_history: {
    self_reported: string; // client's own answer -- authoritative
    usaspending_crosscheck?: string; // supplement/flag only, never overrides self-report
    discrepancy?: string; // set when self-report and USASpending diverge
  };
  inferred: string[]; // fields inferred rather than stated
  gaps: string[]; // thin/missing data -- surfaces confidence
  // Community need-context (U.S. Census ACS 5-year), attached out-of-band AFTER
  // distillation (lib/geo/census.ts). Grounds demonstrated-need language in the
  // enrichment narrative; NOT read by occupancy. Optional -- older stored profiles
  // omit it, and it stays absent when the client's location does not resolve.
  community_context?: CommunityContext | null;
}

// U.S. Census ACS 5-year community need-context. Resolved by place/county NAME from the
// client's stored location; no street address on file means no tract-level precision yet.
// See lib/geo/census.ts. Every field is nullable -- ACS suppresses small-geography values.
export interface CommunityIndicators {
  population: number | null;
  median_household_income: number | null; // dollars
  poverty_rate: number | null; // percent, 0-100
  unemployment_rate: number | null; // percent, 0-100
}
export interface CommunityGeography {
  level: "county" | "place";
  name: string; // e.g. "Pulaski County" | "Little Rock"
  state: string; // 2-letter
  geoid: string; // Census GEOID (anchors source_url)
  indicators: CommunityIndicators;
  source_url: string; // data.census.gov profile
}
// Point geocode from the U.S. Census Geocoder (migration 0064 + lib/geo/census.ts).
// The tract GEOID is the join key for the shortage-area / eligibility overlays
// (HRSA, and later HUD/EJ). Present only when the client has a resolvable street
// address; null otherwise. NOT rendered into narrative on its own -- it is plumbing.
export interface Geocode {
  lat: number;
  lon: number;
  tract_geoid: string; // 11-digit state(2)+county(3)+tract(6)
  state_fips: string;
  county_fips: string;
  tract_code: string; // 6-digit
  matched_address: string; // the address the geocoder actually matched
  source: string; // "US Census Geocoder"
}
// One federal shortage-area designation the org's address falls inside (lib/geo/hrsa.ts).
// HPSA carries a 0-26 score (competitiveness signal); MUA/MUP has no score on the layer.
export interface ShortageDesignation {
  program: "HPSA" | "MUA" | "MUP";
  discipline: string | null; // HPSA: "Primary Care" | "Dental Health" | "Mental Health"; null for MUA/MUP
  score: number | null; // HPSA_SCORE; null for MUA/MUP
  population_type: string | null; // HPSA: e.g. "Geographic HPSA" / "Low Income Population HPSA"
  name: string | null; // MUA/MUP service-area name; null for HPSA (no name field)
  status: string; // always "Designated" (proposed-for-withdrawal is filtered out)
}
export interface ShortageContext {
  checked_at: string; // ISO timestamp of the lookup
  source: string; // "HRSA (data.hrsa.gov ArcGIS)"
  designations: ShortageDesignation[]; // [] = checked, point is in none (a real negative)
}
// HUD place-based designations at the geocoded point (lib/geo/hud.ts). QCT / DDA are
// the LIHTC distress designations and a general need/underservedness marker. Each flag:
// true = designated, false = checked-and-not, null = that layer was unavailable.
export interface HudDesignations {
  checked_at: string; // ISO timestamp of the lookup
  source: string; // "HUD (services.arcgis.com)"
  qct: boolean | null; // Qualified Census Tract
  dda: boolean | null; // Difficult Development Area
}
export interface CommunityContext {
  checked_at: string; // ISO timestamp of the pull
  source: string; // "US Census ACS 5-year"
  vintage: string; // ACS vintage year, e.g. "2022"
  geographies: CommunityGeography[]; // most-specific first (place, then county)
  geocode?: Geocode | null; // point + tract, when a street address resolves
  shortage?: ShortageContext | null; // HRSA shortage-area designations at the geocoded point
  hud?: HudDesignations | null; // HUD QCT/DDA at the geocoded point
}

export interface Grant {
  id: string;
  source_url: string | null;
  funder: string | null;
  fon: string | null;
  // Assistance-listing / CFDA numbers (migration 0041, #107). Populated on the
  // Simpler API path; null for manual-paste / non-Simpler grants. program_award_*
  // are Part 2 (USASpending program-award map) -- columns exist but are unused
  // until then.
  assistance_listings: { number: string; program_title: string }[] | null;
  program_award_summary: Record<string, unknown> | null;
  program_award_checked_at: string | null;
  title: string | null;
  description: string | null;
  // Plain-language GRANT-LEVEL paraphrase of what the program funds (migration 0069),
  // generated once by lib/grants/brief.ts and read by the console detail, the portal
  // detail, and the alert PDF hero. Null = not generated yet; every reader falls back to
  // `description`. Enrichment only -- never read by the occupancy/seat scorer.
  description_brief: string | null;
  description_brief_at: string | null;
  // What the money may be spent on, quote-verified against raw_text (migration 0072),
  // generated by lib/grants/allowable-uses.ts. Shape is
  // `{ items: [{ line, quote }], reason }` -- read it through readAllowableUses(), which
  // tolerates anything unrecognised rather than throwing inside a page render. Null = not
  // generated yet. Enrichment only, and NOT on the alert PDF path.
  allowable_uses: unknown | null;
  allowable_uses_at: string | null;
  allowable_uses_attempts: number | null;
  // NOFO-derived application requirements, quote-verified against raw_text (migration 0081),
  // generated by lib/grants/requirements.ts. Shape is `{ required_sections, page_format_limits,
  // required_attachments, evaluation_criteria, other_notes, reason }` -- read it through
  // readApplicationRequirements(). Null = not generated yet (derived LAZILY on the first
  // compliance-step open, not by a sweep). Enrichment only; never read by the seat scorer.
  application_requirements: unknown | null;
  application_requirements_at: string | null;
  application_requirements_attempts: number | null;
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
  // When the current 'processing' run started (migration 0039). The stuck-pipeline
  // watchdog measures now() - processing_started_at, NOT ingested_at, so a re-match
  // of an old grant isn't flipped mid-run. default now() covers inserts; the
  // re-processing UPDATE paths stamp it explicitly.
  processing_started_at: string | null;
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
  // Why Stage A failed to build a profile on a FULL shred (migration 0048). Null =
  // Stage A succeeded or was not attempted; a message = the last profiling attempt
  // threw (was previously swallowed). Resolver-gap failures live in shred_reason.
  ideal_profile_error: string | null;
  // Closed for prospecting by an admin (migration 0037): drops out of the prospect
  // feed but persists in the Ledger with history. Null = open. Reopen (future
  // Ledger action) sets it back to null.
  prospecting_closed_at: string | null;
  prospecting_closed_by: string | null;
  ingested_at: string;
}

export type CardDecision = "pending" | "approved" | "passed";

// How a client chose to pursue a grant they're interested in (migration 0061).
// null = they haven't decided how yet (the Grant Report's default "pending
// decision" view). Picking one also records decision='approved'. Re-routable.
export type PursuitPath = "intellengine" | "sme" | "in_house";

// An IntellEngine proposal in flight (migration 0062). One row per proposal in
// the IntellEngine hub -- tied to a matched grant (card_id set) or started from
// scratch (card_id null). `status` = the furthest step reached in the
// scope -> compliance -> build flow (structural progress, NOT AI-drafted
// content); it drives the hub's status label and the resume target.
// A file in the per-client document repository (migration 0030, extended by 0075).
//
// TWO POPULATIONS IN ONE TABLE, separated by intellengine_draft_id:
//   null -- an ORG-LEVEL firm record (990, audit, board list). Staff-owned: reusable across
//           every pursuit, and NOT client-deletable.
//   set  -- a specific draft's supporting file. The client's own, and theirs to remove.
//
// `kind` is free text validated in app code rather than a CHECK constraint, as 0030 set it
// up, so the taxonomy can change without a migration.
export interface ClientDocument {
  id: string;
  client_id: string;
  kind: string;
  title: string;
  storage_bucket: string;
  storage_path: string;
  content_type: string | null;
  size_bytes: number | null;
  source_contract_id: string | null;
  created_by: string | null;
  created_at: string;
  intellengine_draft_id: string | null;
  // FAILS CLOSED (0075). Defaults false, and the member SELECT policy requires it, so a row
  // is invisible to clients until something deliberately says otherwise -- which is what
  // keeps signed contracts behind the financial firewall without naming them.
  client_visible: boolean;
  // ── Assimilation (0078) ──
  // 'pending' | 'ready' | 'failed' | 'stale'. A distinct status rather than an inference from
  // `extracted`, because {} cannot distinguish never-run from found-nothing from failed.
  extraction_status: string;
  // The structured summary. Shape is lib/documents/extract-shape.ts ExtractedDocument, read
  // tolerantly -- the DOCUMENT DATE lives in here rather than as a column, because an
  // extracted date is a claim until a human accepts it.
  extracted: Record<string, unknown>;
  extracted_at: string | null;
  // Why extraction failed, so a spreadsheet reads as "we can't read this" rather than as a
  // document containing nothing.
  extraction_error: string | null;
  // The reviewer's own note, copied into each audit row at commit.
  review_note: string | null;
}

// One committed profile field change (0078). Append-only: the table has no UPDATE or DELETE
// policy, and a rollback writes NEW rows rather than removing these.
export interface ClientProfileChange {
  id: string;
  // Groups the fields committed together in one review.
  commit_id: string;
  client_id: string;
  // SET NULL on document delete -- the audit outlives its cause.
  document_id: string | null;
  // 'mission' | 'primary_contact_email' | 'intake_data.programs' ... validated against
  // lib/documents/proposal.ts PROPOSABLE_FIELDS, which is what keeps assimilation unable to
  // write anything a client could not type by hand.
  field: string;
  old_value: unknown;
  new_value: unknown;
  // The AUTH user id, not a profiles id: a client member has no profiles row.
  committed_by: string | null;
  // Snapshotted at commit time so "who changed this" survives a deleted membership.
  committed_by_email: string | null;
  committed_by_kind: string;
  note: string | null;
  committed_at: string;
}

export type IntellEngineDraftStatus = "scope" | "compliance" | "build" | "complete";

export interface IntellEngineDraft {
  id: string;
  client_id: string;
  card_id: string | null;
  title: string;
  // The furthest screen OPENED — a resume pointer, not progress. Progress is derived
  // from `content` (lib/intellengine/content.ts); see migration 0074.
  status: IntellEngineDraftStatus;
  // Scope + section drafts (0074). Read through readDraftContent, never directly: it is
  // jsonb, so a tolerant reader is what keeps a shape change out of the page render.
  content: unknown;
  created_at: string;
  updated_at: string;
}

// Per-factor match sub-scores (#105). Ordinal, never a percentage; a factor whose
// underlying client data is blank reads "insufficient_data" (never a guess).
export type FactorRating = "strong" | "moderate" | "weak" | "insufficient_data";
export interface FactorScore {
  rating: FactorRating;
  rationale: string;
}
export interface FactorScores {
  seat_role: FactorScore;
  eligibility: FactorScore;
  geographic: FactorScore;
  program_history: FactorScore;
  cost_share: FactorScore;
  mission: FactorScore;
}

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
  // Per-factor sub-scores (migration 0038, #105). Null for cards scored before it
  // shipped -- the UI renders a "not yet scored" line rather than breaking.
  factor_scores: FactorScores | null;
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
  // Which side recorded the decision — 'staff' or 'client' (migration 0056). The
  // shared decision surface reads this to attribute a decision ("Pursued by the
  // client" vs "Approved by GRANTED"). Null on undecided cards.
  decided_by_actor: string | null;
  // Grant Alerts gate (migration 0057): set when the card is marked "interested"
  // (right-swipe) -- promotes it into the Grant Report. Deliberately separate
  // from decision -- a low-stakes "worth a closer look" signal, not a commitment.
  // Null means the card hasn't been triaged yet (lives in Grant Alerts, not the
  // Grant Report).
  interested_at: string | null;
  interested_by: string | null;
  interested_by_actor: string | null;
  // How the client chose to pursue this grant (migration 0061). Null until they
  // decide; set alongside decision='approved'. Client-writable (column-lock
  // extended in 0061). Re-routable — a new pick overwrites.
  pursuit_path: PursuitPath | null;
  // Manual add-to-client override audit (migration 0040). overridden_by/at are set
  // on EVERY manual add (human-added vs engine-surfaced); override_reason is set
  // ONLY when the add was FORCED past a gate ("<severity>: <reason>") and drives
  // the "Manual override" badge + the prepended before_you_approve note. All null
  // for engine-surfaced cards.
  overridden_by: string | null;
  overridden_at: string | null;
  override_reason: string | null;
  // Account-managed SME gate (migration 0059): set when staff release a matched card into
  // the client's Grant Report. Null until released. Gates client visibility, and the
  // Ledger's per-card re-match declines to re-score a released card (a client may be
  // looking at it).
  sme_released_at: string | null;
  // Send tracking. Populated by the (not-yet-built) send step.
  sent_at: string | null;
  sent_to: string | null;
  // NOTE: the on-demand IntellEngine QA verdict is NOT a column here — it lives in the staff-only
  // card_intel_reviews table (migration 0086), because RLS is row-level and 0055 exposes review_cards
  // rows to client members. See lib/grants/intel-review.ts.
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

// Horizon Reject gate (migration 0053). One row per (client, grant) forecast the
// client has rejected for the "On the horizon" shortlist. Read ONLY by the forecasted
// render path (loadForecastCandidates) to hide the row BEFORE ranking/capping -- never
// a review_cards decision, so a forecast->posted flip gives the grant a fresh look as
// an active match. `fon` is a forensic backstop; the filter matches on grant_id.
export interface ForecastRejection {
  id: string;
  client_id: string;
  grant_id: string;
  fon: string | null;
  reason: string | null;
  rejected_by: string | null;
  rejected_at: string;
}

// Concept proposal (migration 0060). One per review card (client × grant): the
// internal, AM-facing "practical application" snapshot of how the client would
// pursue the grant, generated on the SME interested pass (0059) and editable by
// staff. Its output shape aligns with the IntellEngine /scope editor so it can
// later prefill that client-facing surface. NOT the multi-API IntellEngine
// proposal developer. See lib/concept/.
export interface ConceptProposalPartner {
  // Exactly one of name / org_type_label carries the identity: a specific org
  // when the fit is obvious enough to name, otherwise an org-type label.
  name: string | null;
  org_type_label: string | null; // e.g. "workforce partner", "fiscal sponsor"
  role: string; // prime / co-applicant / subrecipient / private-industry / ...
  description: string; // <=50 words: what this partner would do
  // Provenance: "client_cited" = from the client's own partners; "prospect" =
  // from a GRANTED-tracked ecosystem org (has a verified source_url); "suggested"
  // = named from the model's own knowledge (UNVERIFIED, flagged for the AM);
  // "manual" = added/named by the account manager in the editor (staff-vetted).
  source: "client_cited" | "prospect" | "suggested" | "manual";
}

export interface ConceptProposal {
  scope: string; // <=500 words, compliance-mapped practical application
  role: "prime" | "partner"; // two-way for now (matches the /scope editor enum)
  total_project_amount: string; // labeled an estimate
  estimated_match: string | null; // estimate from the NOFO cost-share; null = none required
  project_term: string | null; // from period_of_performance; null if the NOFO is silent
  partners: ConceptProposalPartner[];
  // A one-line outreach teaser (<=25 words) generated alongside the proposal — used
  // ONLY to pre-fill a prospect's cold alert email (a hook to spark a conversation,
  // never the full concept, which stays internal). Null if none formed / pre-hook row.
  hook: string | null;
}

export type ConceptProposalStatus = "generating" | "ready" | "error";

export interface ConceptProposalRow {
  id: string;
  card_id: string;
  grant_id: string | null;
  client_id: string | null;
  status: ConceptProposalStatus;
  proposal_data: ConceptProposal | null; // null until status='ready'
  model: string | null;
  error: string | null;
  generated_at: string | null;
  generated_by: string | null;
  edited_at: string | null;
  edited_by: string | null;
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
  contract_id: string | null;
  amount_cents: number;
  currency: string;
  status: string;
  issued_date: string | null;
  due_date: string | null;
  paid_date: string | null;
  stripe_invoice_id: string | null;
  hosted_invoice_url: string | null;
  notes: string | null;
  created_by: string | null;
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
