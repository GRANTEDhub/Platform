-- ╔══════════════════════════════════════════════════════════════════════════╗
-- ║ clients.website — public site captured on the Add-prospect form             ║
-- ╚══════════════════════════════════════════════════════════════════════════╝
-- The lightweight "Add prospect" form (Prospecting landing) captures the org's
-- website. This is its durable home: a plain nullable text column, context for the
-- account manager and available to enrichment. Applies to all clients/leads, not
-- just prospects.
--
-- SAFETY PROPERTIES (why this is safe to apply to prod):
--   1. Additive, nullable column with no default -- every existing row reads NULL,
--      so no current behavior changes. No backfill.
--   2. No policy, trigger, index, matcher, or send path is touched.
--   3. `add column if not exists` -- idempotent, safe to re-run.

begin;

alter table clients add column if not exists website text;

insert into schema_migrations (version) values ('0063_clients_website') on conflict do nothing;
commit;
