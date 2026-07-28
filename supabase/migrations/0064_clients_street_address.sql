-- ╔══════════════════════════════════════════════════════════════════════════╗
-- ║ clients.location_street / location_zip — street address for geocoding        ║
-- ╚══════════════════════════════════════════════════════════════════════════╝
-- The community need-context (migration-free, on client_profile) resolves ACS
-- indicators by city/county NAME. To key the tract-level overlays (HRSA shortage
-- areas, and later HUD/EJ) we need a POINT, which the U.S. Census Geocoder only
-- returns for a full street address ("Little Rock, AR" does not geocode; a street
-- address does). These two nullable columns are that address.
--
-- SAFETY PROPERTIES (why this is safe to apply to prod):
--   1. Additive, nullable columns with no default -- every existing row reads NULL,
--      so no current behavior changes. No backfill.
--   2. No policy, trigger, index, matcher, or send path is touched. Read only by
--      the enrichment/geocode layer (lib/geo/census.ts), never by occupancy.
--   3. `add column if not exists` -- idempotent, safe to re-run.

begin;

alter table clients add column if not exists location_street text;
alter table clients add column if not exists location_zip text;

insert into schema_migrations (version) values ('0064_clients_street_address') on conflict do nothing;
commit;
