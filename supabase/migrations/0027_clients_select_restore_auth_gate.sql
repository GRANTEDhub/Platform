-- ╔══════════════════════════════════════════════════════════════════════════╗
-- ║ Security fix — restore the authentication gate on clients_select             ║
-- ╚══════════════════════════════════════════════════════════════════════════╝
-- Migration 0025 split leads out of the client roster and, in doing so, replaced
-- the original clients_select policy (0001: `using (auth.uid() is not null)`)
-- with one that has NO authentication clause:
--     using (public.is_admin() or pipeline_stage is null or pipeline_stage = 'converted')
-- A policy with no `to`-role restriction applies to the `anon` role too. For an
-- anonymous caller is_admin() is false, but `pipeline_stage is null` is TRUE for
-- every active client (active clients never set pipeline_stage), so anon could
-- read the full active-client roster -- including contact PII -- straight from
-- PostgREST using the public anon key. This restores the auth gate while keeping
-- the lead split intact.
--
-- Resulting access (unchanged from 0025 EXCEPT anon is now denied):
--   * anon (no JWT)           -> NO rows (auth.uid() is null)
--   * admin (authenticated)   -> ALL rows
--   * contractor (authed)     -> active clients (pipeline_stage is null) + converted;
--                                un-converted leads stay hidden (admin-only)

drop policy if exists clients_select on clients;
create policy clients_select on clients for select
  using (
    auth.uid() is not null
    and (public.is_admin() or pipeline_stage is null or pipeline_stage = 'converted')
  );
