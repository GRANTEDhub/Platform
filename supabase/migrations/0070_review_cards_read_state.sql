-- ╔══════════════════════════════════════════════════════════════════════════╗
-- ║ Per-side read state on the Grant Report                                   ║
-- ╚══════════════════════════════════════════════════════════════════════════╝
-- A Grant Report row should look different once it has been read. The catch is that
-- BOTH sides read the same rows through the same component: /clients/<id>/roadmap
-- (staff) and /portal/grants (client) both render GrantReportConsole off the same
-- review_cards. The two dashboards are separate products and must stay that way --
-- staff greying a row must not grey it for the client, and vice versa.
--
-- So this is TWO columns, not one. A single column with an actor tag (the
-- decided_by_actor pattern from 0056) is the wrong shape here: a decision has one
-- author, but a read has two independent ones, and both values have to be able to
-- exist on the same row at the same time.
--
--   * staff_read_at  -- stamped when a staff user opens the card in the console.
--   * client_read_at -- stamped when a client member opens the grant in their portal.
--
-- FIRST READ WINS on both. Neither write overwrites a non-null value, so the
-- timestamp means "when this side first read it", not "last touched". That is what
-- makes an explicit mark-as-unread meaningful: clearing to null genuinely restores
-- the unread state rather than being re-stamped by the next render.
--
-- No index. Read state is never a query predicate -- both surfaces already fetch the
-- client's whole card list and derive the flag per row in the shaping layer, and the
-- bulk mark-unread updates by primary key. An index here would be write cost for a
-- scan that never happens.
--
-- Enrichment only, like usaspending_summary (0024) and description_brief (0069): the
-- occupancy/seat scorer never reads either column, so neither can move a fit score
-- or flip a seat.
begin;

alter table review_cards add column if not exists staff_read_at timestamptz;
alter table review_cards add column if not exists client_read_at timestamptz;

-- ── guard_card_approval: 0068's body VERBATIM plus 'client_read_at' in the
--    CLIENT-MEMBER column-lock, and NOWHERE ELSE.
--
--    WHY THIS FUNCTION HAS TO BE TOUCHED AT ALL. The client-member branch is a
--    fail-closed jsonb diff: a portal user may change only the columns explicitly
--    subtracted from both sides of the comparison, and anything else raises. That is
--    the property that makes adding columns to review_cards safe by default -- but it
--    also means a portal user cannot stamp their OWN read state until the column is
--    named here. Without this edit, opening a grant in the portal would raise
--    'Client members may only change the decision on this card'.
--
--    AND WHY ONLY THERE. staff_read_at is deliberately NOT added to any client-
--    reachable allowlist, so a portal session physically cannot mark a row read on
--    staff's side -- Postgres raises, rather than the app choosing not to. That is
--    the isolation guarantee this migration exists to provide, and it is enforced
--    here rather than in a route handler.
--
--    The TOKEN branch is left alone on purpose. A one-click decision from the alert
--    email is not a portal read: the reader may never have opened the portal at all,
--    and stamping client_read_at from an email click would grey a row the client has
--    not actually looked at. It greys on their next portal visit instead.
--
--    The staff branch keeps no column lock (staff own this table), so the console
--    writing client_read_at is prevented by code, not by Postgres. Nothing does, and
--    nothing should; noted so the asymmetry is deliberate rather than discovered.
--
--    Trigger binding (BEFORE UPDATE on review_cards) is untouched -- only the
--    function body is replaced. ──
create or replace function public.guard_card_approval()
returns trigger
language plpgsql security definer set search_path = public
as $$
begin
  -- Token-authenticated client decision (the alert email's Interested / Not-for-us
  -- links). current_setting(..., true) yields NULL when unset, and NULL = text is
  -- NULL, so an ordinary write simply falls through to the branches below.
  if current_setting('argo.decision_token_card', true) = new.id::text then
    -- Same column-lock the client-member branch enforces: a decision link may move
    -- the decision/interest fields and nothing else. NOT client_read_at -- see above.
    if (to_jsonb(old)
          - 'decision' - 'decision_reason' - 'decided_by' - 'decided_at' - 'decided_by_actor'
          - 'interested_at' - 'interested_by' - 'interested_by_actor'
          - 'pursuit_path')
       is distinct from
       (to_jsonb(new)
          - 'decision' - 'decision_reason' - 'decided_by' - 'decided_at' - 'decided_by_actor'
          - 'interested_at' - 'interested_by' - 'interested_by_actor'
          - 'pursuit_path') then
      raise exception 'A decision link may only change the decision on this card';
    end if;
    -- Defence in depth. The function below never sets 'approved', but a decision
    -- link must not be a route around the admin-only approve gate even if it did:
    -- approving a match for client delivery is our call, not an email click.
    if new.decision = 'approved' and old.decision is distinct from 'approved' then
      raise exception 'A decision link cannot approve a match for delivery';
    end if;
    return new;
  end if;

  if not public.is_staff() then
    if not public.is_client_member_of(new.client_id) then
      raise exception 'Not authorized to modify this card';
    end if;
    if (to_jsonb(old)
          - 'decision' - 'decision_reason' - 'decided_by' - 'decided_at' - 'decided_by_actor'
          - 'interested_at' - 'interested_by' - 'interested_by_actor'
          - 'pursuit_path' - 'client_read_at')
       is distinct from
       (to_jsonb(new)
          - 'decision' - 'decision_reason' - 'decided_by' - 'decided_at' - 'decided_by_actor'
          - 'interested_at' - 'interested_by' - 'interested_by_actor'
          - 'pursuit_path' - 'client_read_at') then
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

insert into schema_migrations (version) values ('0070_review_cards_read_state') on conflict do nothing;
commit;
