-- Staff-entered IRS EIN + cached IRS Form 990 financials for a client/prospect.
--
-- Purpose: auto-pull annual budget (and expenses/assets) from the org's most recent
-- IRS 990 via the ProPublica Nonprofit Explorer, keyed on the EIN, so "annual budget"
-- is a sourced, dated CITATION rather than a hand-typed guess. Like usaspending_summary
-- (0024), this is ENRICHMENT ONLY -- it grounds narrative + flags and is never read by
-- the occupancy/seat scorer; a save preserves it (the client form omits it from its
-- write) and a monthly-style refresh re-caches it.
--
--   * ein: the staff-entered 9-digit IRS EIN (stored as text; digits only recommended).
--   * nonprofit_finance: cached ProPublica result (NonprofitFinance JSON) or null.
--   * nonprofit_finance_checked_at: last successful refresh; a failed lookup does NOT
--     advance it, so it retries (parity with usaspending_checked_at).
--
-- All additive + nullable; no backfill. Applies to all clients + un-converted leads.
begin;

alter table clients add column if not exists ein text;
alter table clients add column if not exists nonprofit_finance jsonb;
alter table clients add column if not exists nonprofit_finance_checked_at timestamptz;

insert into schema_migrations (version) values ('0067_clients_ein_nonprofit_finance') on conflict do nothing;
commit;
