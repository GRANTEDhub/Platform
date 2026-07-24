-- ╔══════════════════════════════════════════════════════════════════════════╗
-- ║ Premium tier: an account-manager (SME) pass ahead of the client's own       ║
-- ╚══════════════════════════════════════════════════════════════════════════╝
-- For an account-managed client, a match should go through the SAME two-gate
-- shape (Grant Alerts -> Grant Report) staff already run for the client, TWICE:
-- once internally (staff, as the SME) and once externally (the client), before
-- the client ever sees it. For a standard client, nothing changes -- it skips
-- straight to the client's own Grant Alerts/Report exactly as today.
--
-- clients.account_managed is the tier gate. Deliberately a plain boolean, not a
-- reuse of the existing free-text engagement_tier (that field is narrative --
-- fed to the matching engine's prompt as descriptive context, e.g. "Flex" /
-- "Navigate" -- not something code has ever branched logic on). This is a
-- dedicated, reliable flag for the one thing this gate cares about.
--
-- The SME fields on review_cards are a SEPARATE parallel track from the
-- client-facing interested_at/decision (0057) -- NOT a reuse. This is
-- deliberate: if staff's own "interested" mark used the SAME interested_at
-- field the client checks, the card would already read as interested by the
-- time the client looked, skipping their own Grant Alerts pass entirely --
-- exactly the collision flagged before any of this was built. Two independent
-- passes need two independent states:
--   sme_interested_at/by  -- staff's own Grant Alerts gate (mirrors interested_at)
--   sme_released_at/by    -- staff's own Grant Report gate: "reviewed (eventually
--                              alongside a concept proposal -- not built yet) and
--                              releasing to the client now." Only once this is set
--                              does the card become eligible for the CLIENT's own
--                              Grant Alerts.
-- A staff reject at either of their own gates reuses decision='passed' (shared,
-- safe -- it's terminal, nothing else ever acts on the card again either way).
--
-- sme_interested_by/sme_released_by are staff-only by construction (there is no
-- client-side path that ever sets them), so no actor discriminator column is
-- needed the way interested_by_actor/decided_by_actor exist on the client track.
-- They reference profiles(id) (not auth.users like the client-facing columns --
-- see 0057/0058) because these are ALWAYS a staff member, never a client.
--
-- No guard_card_approval changes needed: the trigger's client column-lock is
-- fail-closed by design (0056) -- any column not explicitly whitelisted for
-- clients stays staff-only automatically, so these new columns are protected
-- for free. The pages that read/write them are also all behind requireAdmin()
-- already, matching how the existing staff roadmap/triage pages are gated.

begin;

alter table clients add column if not exists account_managed boolean not null default false;

alter table review_cards add column if not exists sme_interested_at timestamptz;
alter table review_cards add column if not exists sme_interested_by uuid references profiles(id) on delete set null;
alter table review_cards add column if not exists sme_released_at timestamptz;
alter table review_cards add column if not exists sme_released_by uuid references profiles(id) on delete set null;

create index if not exists review_cards_sme_interested_idx
  on review_cards(sme_interested_at) where sme_interested_at is not null;
create index if not exists review_cards_sme_released_idx
  on review_cards(sme_released_at) where sme_released_at is not null;

insert into schema_migrations (version) values ('0059_account_managed_sme_gate') on conflict do nothing;
commit;
