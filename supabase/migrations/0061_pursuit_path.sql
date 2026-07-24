-- ╔══════════════════════════════════════════════════════════════════════════╗
-- ║ Pursuit path — how a client chooses to pursue a grant they're interested in  ║
-- ╚══════════════════════════════════════════════════════════════════════════╝
-- The Grant Report becomes a decision workflow: once a client marks a grant
-- Interested (0057) and it lands in the Report, they choose HOW to pursue it —
-- write it with IntellEngine (premium), work with a subject-matter expert, or
-- pursue in-house. That choice is `pursuit_path`; picking one also records the
-- card as pursued (decision='approved', already client-settable since 0056), so
-- the existing decided_by / decided_at / decided_by_actor attribution doubles as
-- the activity log — no new logging table. Re-routable (a new pick overwrites).
--
-- SAFETY PROPERTIES (why this is safe to apply to prod):
--   1. Additive column, nullable, default null = "hasn't decided how to pursue" —
--      every existing card reads as undecided, so no behavior changes on apply.
--   2. Client column-lock (guard_card_approval) is extended to also allow
--      pursuit_path, mirroring how 0057 added the interest fields. The function
--      body below is the CURRENT 0057 body verbatim + pursuit_path in the diff
--      exclusion; the staff admin-approve gate is byte-for-byte unchanged.
--   3. No send path is touched. Choosing a pursuit path never sends email.
--   4. CHECK constrains the value set; the column is fail-closed for clients
--      until this guard change, and unknown values are rejected by the CHECK.

begin;

-- ── The pursuit path. Nullable = undecided (the Report's default "pending
--    decision" view). CHECK bounds the value set; add idempotently. ──
alter table review_cards add column if not exists pursuit_path text;

alter table review_cards drop constraint if exists review_cards_pursuit_path_check;
alter table review_cards add constraint review_cards_pursuit_path_check
  check (pursuit_path is null or pursuit_path in ('intellengine', 'sme', 'in_house'));

-- Partial index for the "in progress" filter (any path chosen).
create index if not exists review_cards_pursuit_path_idx
  on review_cards(pursuit_path) where pursuit_path is not null;

-- ── guard_card_approval: extend the client column-lock to also allow
--    pursuit_path. Same shape as 0057 (which added the interest fields) — staff
--    branch (the admin-approve gate) untouched. Trigger binding is not touched;
--    only the function body is replaced. ──
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
          - 'interested_at' - 'interested_by' - 'interested_by_actor'
          - 'pursuit_path')
       is distinct from
       (to_jsonb(new)
          - 'decision' - 'decision_reason' - 'decided_by' - 'decided_at' - 'decided_by_actor'
          - 'interested_at' - 'interested_by' - 'interested_by_actor'
          - 'pursuit_path') then
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

insert into schema_migrations (version) values ('0061_pursuit_path') on conflict do nothing;
commit;
