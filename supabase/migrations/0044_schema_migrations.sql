-- ╔══════════════════════════════════════════════════════════════════════════╗
-- ║ schema_migrations ledger: make an unapplied migration VISIBLE, not silent    ║
-- ╚══════════════════════════════════════════════════════════════════════════╝
-- Migrations here are hand-applied SQL files (no CLI, no tracking table), so a
-- skipped file used to fail silently: a later write just no-op'd against a
-- missing column (incident: 0043 client_profile was deferred as "apply later",
-- slipped, and Stage 2's writes would have silently no-op'd had it not been
-- caught). This ledger records every applied migration so a gap is queryable
-- (loud, not silent) -- the same principle as the /api/version probe and the
-- match watchdog.
--
-- CONVENTION (see CLAUDE.md): every FUTURE migration ends with its own
--   insert into schema_migrations (version) values ('<stem>') on conflict do nothing;
-- inside a begin/commit wrapper, so applying the file = running the DDL AND
-- recording it, atomically. Check applied state any time with:
--   select version, applied_at from schema_migrations order by version;
-- and diff against `ls supabase/migrations/` -- any file NOT in the result is
-- unapplied.
--
-- This bootstrap backfills 0001-0044 as applied: they are all live in prod
-- (platform runs; 0038-0043 columns confirmed present 2026-07-12). It is a
-- baseline DECLARATION of current state -- it cannot retroactively verify each
-- older file, but the platform functioning is the evidence. Correctness is
-- guaranteed going forward. No app code reads this table; it is observability only.

begin;

create table if not exists schema_migrations (
  version     text primary key, -- the migration filename stem, e.g. "0043_clients_client_profile"
  applied_at  timestamptz not null default now()
);

insert into schema_migrations (version) values
  ('0001_init'),
  ('0002_grant_intelligence'),
  ('0003_fix_role_guard_bootstrap'),
  ('0004_grant_error_detail'),
  ('0005_grant_domestic_flag'),
  ('0006_grant_hard_disqualifiers'),
  ('0007_review_decision_fields'),
  ('0008_client_matching_rules'),
  ('0009_match_attempts'),
  ('0010_review_cards_dedup'),
  ('0011_grant_shred_depth'),
  ('0012_grant_ideal_applicant_profile'),
  ('0013_match_feedback'),
  ('0014_grants_source_url_unique'),
  ('0015_client_usaspending_overrides'),
  ('0016_clients_name_unique'),
  ('0017_review_cards_hold_category'),
  ('0018_clients_hard_constraints'),
  ('0019_prospects_and_card_type'),
  ('0020_grants_skip_reason'),
  ('0021_grants_activated_from_forecast'),
  ('0022_access_tokens_and_pipeline_events'),
  ('0023_clients_sam_registration'),
  ('0024_clients_usaspending_cache'),
  ('0025_lead_data_model'),
  ('0026_client_overview_pipeline_stage'),
  ('0027_clients_select_restore_auth_gate'),
  ('0028_audit_closeout_rls_hardening'),
  ('0029_contracts'),
  ('0030_contract_pdf_storage_and_documents'),
  ('0031_stage_reshape_expand'),
  ('0032_stage_reshape_contract'),
  ('0033_stripe_payments'),
  ('0034_client_converted_at'),
  ('0035_grant_alerts'),
  ('0036_prospect_alert_send'),
  ('0037_grant_prospecting_closed'),
  ('0038_review_cards_factor_scores'),
  ('0039_grant_processing_started_at'),
  ('0040_review_cards_manual_override'),
  ('0041_grants_assistance_listings'),
  ('0042_grants_match_retry_count'),
  ('0043_clients_client_profile'),
  ('0044_schema_migrations')
on conflict (version) do nothing;

commit;
