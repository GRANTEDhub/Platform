-- ╔══════════════════════════════════════════════════════════════════════════╗
-- ║ Grant Alerts: an "interested" gate ahead of the Grant Report                  ║
-- ╚══════════════════════════════════════════════════════════════════════════╝
-- A brand-new match currently shows up in BOTH the swipe view and the Grant
-- Report list simultaneously. This adds a real first gate: a card must be marked
-- "interested" (right-swipe in Grant Alerts) before it's promoted into the Grant
-- Report. Rejecting (left-swipe / Pass) still writes decision='passed' exactly as
-- today, at either gate -- no change there.
--
-- Deliberately a SEPARATE signal from `decision`. "Interested" is a low-stakes,
-- reversible "worth a closer look" flag, not a commitment -- decision stays the
-- one true pursue/pass call, unchanged in meaning or in how the existing
-- Approve/Pass controls on the Grant Report work.
--
-- Bug fix bundled in (found while adding the matching interested_by column):
-- decided_by has always had a hard FK to profiles(id), but client portal members
-- deliberately have NO profiles row (that's how the system tells clients apart
-- from staff -- see handle_new_user, migration 0055). So a client's own decision
-- write (their id stamped into decided_by) has been violating that FK the whole
-- time client writes have been open (0056) -- just never hit by a real client
-- session yet. Fix: repoint the FK at auth.users(id), the one id space that
-- covers both staff and clients (client_members.user_id already does this).
-- interested_by is created against auth.users(id) from the start so it doesn't
-- inherit the same bug.
--
-- Same bug, second instance: match_feedback.created_by has the identical hard FK
-- to profiles(id), and 0056 already opened match_feedback inserts to clients too
-- (the agree/flag score control) -- fixed here for the same reason, before the
-- Grant Alerts feedback control goes live for real client use.

begin;

alter table review_cards drop constraint if exists review_cards_decided_by_fkey;
alter table review_cards add constraint review_cards_decided_by_fkey
  foreign key (decided_by) references auth.users(id) on delete set null;

alter table match_feedback drop constraint if exists match_feedback_created_by_fkey;
alter table match_feedback add constraint match_feedback_created_by_fkey
  foreign key (created_by) references auth.users(id) on delete set null;

alter table review_cards add column if not exists interested_at timestamptz;
alter table review_cards add column if not exists interested_by uuid references auth.users(id) on delete set null;
alter table review_cards add column if not exists interested_by_actor text;

create index if not exists review_cards_interested_idx
  on review_cards(interested_at) where interested_at is not null;

-- Backfill: every existing card has already been "seen" one way or another (it's
-- either sitting in someone's Grant Report today, or already decided) -- so
-- nothing already-visible should vanish once the Grant Report query starts
-- requiring interested_at. Going forward, only newly-created matches start out
-- ungated (interested_at null) and must pass through Grant Alerts first.
update review_cards set interested_at = coalesce(decided_at, created_at) where interested_at is null;

-- guard_card_approval: extend the client column-lock to also allow the interest
-- fields. Same shape as 0056 -- staff branch (the admin-approve gate) untouched.
create or replace function public.guard_card_approval()
returns trigger
language plpgsql security definer set search_path = public
as $$
begin
  if not public.is_staff() then
    if not public.is_client_member_of(new.client_id) then
      raise exception 'Not authorized to modify this card';
    end if;
    if (to_jsonb(old)
          - 'decision' - 'decision_reason' - 'decided_by' - 'decided_at' - 'decided_by_actor'
          - 'interested_at' - 'interested_by' - 'interested_by_actor')
       is distinct from
       (to_jsonb(new)
          - 'decision' - 'decision_reason' - 'decided_by' - 'decided_at' - 'decided_by_actor'
          - 'interested_at' - 'interested_by' - 'interested_by_actor') then
      raise exception 'Client members may only change the decision on this card';
    end if;
    return new;
  end if;

  if new.decision = 'approved'
     and old.decision is distinct from 'approved'
     and not public.is_admin() then
    raise exception 'Only admins can approve a match for client delivery';
  end if;
  return new;
end;
$$;

insert into schema_migrations (version) values ('0057_grant_alerts_interest_gate') on conflict do nothing;
commit;
