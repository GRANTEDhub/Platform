-- 0093 — client referral tracking: the "forwarded internally" note field.
--
-- Lets a client record that they forwarded a grant to a colleague INTERNALLY and are awaiting a response —
-- a single-user self-annotation on their own card. Two parts: a new decision VALUE 'forwarded' (a real
-- state distinct from Pursue/Pass) and a free-text "sent to" note.
--
-- The decision VALUE needs NO schema change — `decision` is a plain text column with no CHECK constraint;
-- its value set is bounded in code (types/database.ts CardDecision + the /api/review/[id] whitelist), not
-- the DB. Only the note column + the client column-lock need DB changes.
--
-- guard_card_approval() column-locks a client member to the decision fields (0089, the current definition —
-- verified nothing after it redefines the function). Recording a 'forwarded' decision writes forwarded_to
-- too, so it is added to that lock's allow-list, or the client's update raises. Reproduced VERBATIM from
-- 0089 with `- 'forwarded_to'` added to the CLIENT-MEMBER branch ONLY — the service-role fast-path, the
-- email decision-token branch, and the staff path are UNCHANGED. A forward is a logged-in portal action,
-- never a token/email write, so the token branch is not widened. Trigger BINDING (BEFORE UPDATE, from 0002)
-- is untouched — this replaces only the function body, exactly as every prior guard migration did.
begin;

alter table review_cards add column if not exists forwarded_to text;

create or replace function public.guard_card_approval()
returns trigger
language plpgsql security definer set search_path = public
as $$
begin
  if coalesce(
       nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role',
       nullif(current_setting('request.jwt.claim.role', true), '')
     ) = 'service_role' then
    return new;
  end if;

  if current_setting('argo.decision_token_card', true) = new.id::text then
    if (to_jsonb(old)
          - 'decision' - 'decision_reason' - 'decided_by' - 'decided_at' - 'decided_by_actor'
          - 'interested_at' - 'interested_by' - 'interested_by_actor' - 'pursuit_path')
       is distinct from
       (to_jsonb(new)
          - 'decision' - 'decision_reason' - 'decided_by' - 'decided_at' - 'decided_by_actor'
          - 'interested_at' - 'interested_by' - 'interested_by_actor' - 'pursuit_path') then
      raise exception 'A decision link may only change the decision on this card';
    end if;
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
          - 'pursuit_path' - 'client_read_at' - 'forwarded_to')
       is distinct from
       (to_jsonb(new)
          - 'decision' - 'decision_reason' - 'decided_by' - 'decided_at' - 'decided_by_actor'
          - 'interested_at' - 'interested_by' - 'interested_by_actor'
          - 'pursuit_path' - 'client_read_at' - 'forwarded_to') then
      raise exception 'Client members may only change the decision on this card';
    end if;
    return new;
  end if;

  return new;
end;
$$;

insert into schema_migrations (version) values ('0093_client_referral_tracking') on conflict do nothing;
commit;
