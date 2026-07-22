-- ╔══════════════════════════════════════════════════════════════════════════╗
-- ║ Shared decision surface — client-member decisions + score feedback           ║
-- ╚══════════════════════════════════════════════════════════════════════════╝
-- Slice 2 of the client-facing operations hub. The Grant Report is now a shared
-- decision surface: a client portal member can record a decision (Pursue = approved
-- / Save for Later = pending / Pass = passed) on THEIR OWN client's card, tracked by
-- decided_by, and can flag/agree with the fit score. Today only staff can write
-- these; this migration opens the two writes to client members — safely.
--
-- SAFETY PROPERTIES (why this is safe to apply to prod):
--   1. No new behavior for staff. The staff branch of guard_card_approval is
--      byte-for-byte the old rule (contractors can't approve; only admins can).
--   2. Client writes are inert until a client_members row is activated — none can
--      write today because is_client_member_of() requires an activated membership.
--   3. A client member is COLUMN-LOCKED by the guard trigger: on their own card they
--      may change ONLY decision / decision_reason / decided_by / decided_at. Any
--      attempt to touch fit_score, why_this_org, or any other engine output raises.
--      The lock is a jsonb diff, so columns added to review_cards later stay
--      protected by default (fail-closed).
--   4. NO send path is touched. Outreach email fires only through the alert route
--      (POST /api/alerts/[cardId]/send); recording a decision never sends anything.
--
-- Consequence to note (intended, per the unified-decision design): a client's
-- "Pursue" writes decision='approved', so client picks now share the 'approved'
-- bucket with staff-alerted cards. The surface attributes each decision by
-- decided_by so staff can tell a client pick from their own.

begin;

-- ── Actor attribution: which SIDE recorded the decision ('staff' | 'client').
--    Nullable; stamped by the decision write path alongside decided_by. Lets the
--    shared surface show "Pursued by [client]" vs "Approved by GRANTED" without a
--    cross-table lookup. Null on undecided (pending) cards. ──
alter table review_cards add column if not exists decided_by_actor text;

-- ── guard_card_approval: extend to allow client-member decisions on their own
--    card, column-locked; staff path unchanged. Trigger binding (BEFORE UPDATE on
--    review_cards) is untouched — we only replace the function body. ──
create or replace function public.guard_card_approval()
returns trigger
language plpgsql security definer set search_path = public
as $$
begin
  -- Non-staff writer = client portal member. Must be a member of THIS card's
  -- client, and may change ONLY the decision fields. (old is always present:
  -- the trigger is BEFORE UPDATE.)
  if not public.is_staff() then
    if not public.is_client_member_of(new.client_id) then
      raise exception 'Not authorized to modify this card';
    end if;
    if (to_jsonb(old) - 'decision' - 'decision_reason' - 'decided_by' - 'decided_at' - 'decided_by_actor')
       is distinct from
       (to_jsonb(new) - 'decision' - 'decision_reason' - 'decided_by' - 'decided_at' - 'decided_by_actor') then
      raise exception 'Client members may only change the decision on this card';
    end if;
    return new; -- client members MAY set 'approved' (Pursue) on their own card
  end if;

  -- Staff path — unchanged from migration 0002: contractors cannot approve; only
  -- admins can move a card to 'approved' for client delivery.
  if new.decision = 'approved'
     and old.decision is distinct from 'approved'
     and not public.is_admin() then
    raise exception 'Only admins can approve a match for client delivery';
  end if;
  return new;
end;
$$;

-- ── review_cards: let a client member UPDATE their own client's cards. This is a
--    permissive policy that ORs with the staff `review_write` (for all) policy, so
--    effective UPDATE = staff OR own-client-member. The guard trigger above is what
--    keeps a client's update to decision-only. INSERT/DELETE stay staff-only
--    (review_write), since this policy is UPDATE-scoped. ──
drop policy if exists review_client_decide on review_cards;
create policy review_client_decide on review_cards for update
  using (public.is_client_member_of(client_id))
  with check (public.is_client_member_of(client_id));

-- ── match_feedback: let a client member insert feedback for their own client's
--    card (the agree/disagree calibration signal — e.g. "we don't want equipment
--    grants"). Replaces the staff-only insert policy with staff-OR-own-client.
--    SELECT stays staff-only (the calibration dataset is not client-readable). ──
drop policy if exists match_feedback_insert on match_feedback;
create policy match_feedback_insert on match_feedback for insert
  with check (public.is_staff() or public.is_client_member_of(client_id));

insert into schema_migrations (version) values ('0056_client_decisions') on conflict do nothing;
commit;
