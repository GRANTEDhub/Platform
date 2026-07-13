-- Tighten grants writes to admin-only at the DB layer.
--
-- Before (0001): grants INSERT/UPDATE were gated on `auth.uid() is not null`,
-- so ANY authenticated user -- including a contractor -- could insert or update
-- grant rows directly via the Supabase REST/anon API, bypassing the app. This
-- closes that direct-REST write surface.
--
-- Safe with no app change: EVERY real grants writer runs through the SERVICE-ROLE
-- client, which bypasses RLS and is unaffected by this policy --
--   * the daily Grants.gov cron ingest (app/api/cron/ingest, createServiceClient),
--   * the on-demand /api/grants/ingest route (createServiceClient; the user
--     client there is only for the auth check),
--   * runPipeline/runMatching, the match-queue drain, the watchdog sweep, the
--     program-award writer, and every backfill route -- all passed a service client.
-- Verified: no grants INSERT/UPDATE is issued through the RLS-enforced user client.
--
-- SELECT is intentionally left OPEN (auth.uid() is not null) so contractors keep
-- reading and working grants (/grants, /grants/[id], the review queue). DELETE is
-- already admin-only (0001) and is not touched here. Mirrors the clients_write
-- admin-only pattern (0001): `using (is_admin()) with check (is_admin())`.

begin;

drop policy if exists grants_insert on grants;
create policy grants_insert on grants for insert
  with check (public.is_admin());

drop policy if exists grants_update on grants;
create policy grants_update on grants for update
  using (public.is_admin()) with check (public.is_admin());

insert into schema_migrations (version) values ('0046_grants_write_admin_only') on conflict do nothing;

commit;
