-- ╔══════════════════════════════════════════════════════════════════════════╗
-- ║ clients.profile_confirmed_at — first-login profile review gate (#16)         ║
-- ╚══════════════════════════════════════════════════════════════════════════╝
-- A client invited via the lean onboarding flow (invite-actions.ts) lands with
-- org_type / location / narrative deliberately blank. On first portal login the
-- portal layout redirects them to /welcome to review + fill that profile;
-- confirming stamps this column and the redirect stops firing. NULL = not yet
-- confirmed (show the review); non-null = confirmed (straight to the dashboard).
--
-- SAFETY PROPERTIES (why this is safe to apply to prod):
--   1. Additive, nullable column, no default -- the column itself changes no
--      behavior. No policy / trigger / index / matcher / send path is touched.
--      `add column if not exists` -- idempotent, safe to re-run.
--   2. The ONE behavior the app attaches to NULL is the /welcome redirect. To keep
--      already-onboarded clients from being sent through a review they don't need,
--      backfill profile_confirmed_at = now() for any client that already has a real
--      profile (org_type is not null -- the invite flow leaves it blank; a
--      fully-onboarded client has it). So only genuinely-blank invited clients get
--      the review; every established client is treated as already confirmed.
--   3. Read only under the existing clients_select RLS (0055): a member sees their
--      own row, staff see all -- no new policy needed. The confirm write runs
--      service-role, hard-scoped to the caller's own clientId in the server action.
--   4. Migration-first: the layout read fails OPEN (Supabase returns an error, not
--      a throw, if the column is absent), so shipping the code before applying this
--      simply doesn't gate -- it never 500s the portal.

begin;

alter table clients add column if not exists profile_confirmed_at timestamptz;

-- Established clients (a populated org_type = onboarded the old way) are treated as
-- already confirmed, so applying this never forces an existing portal client
-- through the new first-login review. Invited-but-unfilled clients (org_type null)
-- stay NULL and get the review on first login.
update clients
   set profile_confirmed_at = now()
 where profile_confirmed_at is null
   and org_type is not null;

insert into schema_migrations (version) values ('0065_clients_profile_confirmed_at') on conflict do nothing;
commit;
