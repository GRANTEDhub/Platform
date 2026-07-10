-- ╔══════════════════════════════════════════════════════════════════════════╗
-- ║ Grant assistance-listing (CFDA) capture (#107 Part 1)                        ║
-- ╚══════════════════════════════════════════════════════════════════════════╝
-- Simpler.gov returns the program's assistance-listing / CFDA numbers on every
-- opportunity (top-level opportunity_assistance_listings, an array of
-- { assistance_listing_number, program_title }; verified 6/6 populated on live
-- data). We captured none of it. This stores it so a later USASpending program-
-- award map can key on the CFDA number.
--
--   assistance_listings shape (jsonb array):
--     [{ "number": "93.532", "program_title": "Center for Mental Health Services…" }]
--   Populated for Simpler-sourced grants going forward + a bounded backfill of
--   client-matched grants; null for manual-paste / non-Simpler grants (no source).
--
-- The other two columns belong to Part 2 (the USASpending program-award map) and
-- are UNUSED until then -- added here only to avoid a second prod migration. All
-- additive/nullable; no behavior change; existing grants RLS covers them.

alter table grants add column if not exists assistance_listings      jsonb;
alter table grants add column if not exists program_award_summary     jsonb;       -- Part 2 (unused until then)
alter table grants add column if not exists program_award_checked_at  timestamptz; -- Part 2 (unused until then)
