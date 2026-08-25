-- ╔══════════════════════════════════════════════════════════════════════════╗
-- ║ client_members.setup_notified_at: exactly-once staff signup notification     ║
-- ╚══════════════════════════════════════════════════════════════════════════╝
--
-- The signup-notification (#428) emails staff when an invited client finishes
-- setting their password, so a match run can be triggered. That notify is fired
-- from notifyAccountSetupComplete, a server action -- which compiles to a POST
-- endpoint an authenticated invited client can invoke directly, on repeat. The
-- page's submit-guards only stop the honest double-tap; profile_confirmed_at is
-- org-level and doesn't flip until the client confirms at /welcome, so between
-- setup and confirm a scripted replay could flood the inbox and burn Resend.
--
-- This column is the exactly-once claim. notifyAccountSetupComplete stamps it
-- with a conditional UPDATE (`... where id = $member and setup_notified_at is
-- null`) and only sends when THAT update wins the row -- so each member is
-- notified at most once no matter how many times the action is called. It is
-- per-MEMBER (each seat notifies once when it completes), distinct from the
-- org-level profile_confirmed_at gate that skips an already-onboarded org.
--
-- MIGRATION-FIRST, ahead of the code that references it. `add column if not
-- exists` + nullable (no default) is backward-compatible: every existing row is
-- NULL (= not yet notified), so applying this ahead of the merge is a no-op on
-- the live surface. Nullable non-defaulted add is a cheap metadata-only change
-- (no table rewrite), so it stays inside the transaction wrapper + ledger insert.

begin;

alter table client_members
  add column if not exists setup_notified_at timestamptz;

insert into schema_migrations (version) values ('0085_client_members_setup_notified_at') on conflict do nothing;

commit;
