-- ╔══════════════════════════════════════════════════════════════════════════╗
-- ║ Security review close-out — wall lead/prospect surfaces + pin profile role   ║
-- ╚══════════════════════════════════════════════════════════════════════════╝
-- Two RLS hardenings applied together (both pure policy DDL):
--   M1 — pipeline_events / access_tokens / prospects SELECT was any-authenticated
--        (auth.uid() is not null), so a contractor could read lead/BD activity
--        (outreach recipient emails + subjects, note bodies, contract/invoice
--        signals) via direct PostgREST even though lead ROWS are admin-only.
--        Scope these SELECTs to admins, matching the lead-model intent. Verified
--        safe: every app read of these tables is either service-role (bypasses
--        RLS) or an admin-gated page reading as the admin; no non-admin read
--        exists. Inserts are service-role and unaffected by a SELECT policy.
--   L1 — profiles_update had no WITH CHECK; role escalation was blocked ONLY by
--        the guard_role_change() trigger (0003). Add a WITH CHECK that pins role
--        to the caller's current role for non-admins, so a future refactor that
--        drops the trigger can't reopen self-escalation. Service-role/SQL
--        (auth.uid() null) bypasses RLS entirely, so admin bootstrap is
--        unaffected.

-- ── M1: admin-only SELECT on the lead/prospect surfaces ──
drop policy if exists pipeline_events_select on pipeline_events;
create policy pipeline_events_select on pipeline_events for select
  using (public.is_admin());

drop policy if exists access_tokens_select on access_tokens;
create policy access_tokens_select on access_tokens for select
  using (public.is_admin());

drop policy if exists prospects_select on prospects;
create policy prospects_select on prospects for select
  using (public.is_admin());

-- ── L1: pin profiles.role for non-admins (belt-and-suspenders vs the trigger) ──
-- A policy WITH CHECK sees only the NEW row, so we compare role to the caller's
-- CURRENT stored role via a SECURITY DEFINER helper (definer avoids RLS
-- recursion on profiles, same technique as is_admin()). The helper returns
-- user_role (the enum type of profiles.role) so the comparison is
-- user_role = user_role, not user_role = text (which has no operator).
create or replace function public.current_profile_role()
returns public.user_role
language sql
security definer
stable
set search_path = public
as $$ select role from public.profiles where id = auth.uid() $$;

drop policy if exists profiles_update on profiles;
create policy profiles_update on profiles for update
  using (id = auth.uid() or public.is_admin())
  with check (
    public.is_admin()
    or role = public.current_profile_role()
  );
