-- ╔══════════════════════════════════════════════════════════════════════════╗
-- ║ clients.intake_data merges in the DATABASE, under a row lock.              ║
-- ╚══════════════════════════════════════════════════════════════════════════╝
-- Three separate paths merge keys into clients.intake_data, and all three do it in
-- APPLICATION code: read the whole jsonb, change one key in JS, write the whole
-- object back.
--
--   lib/documents/commit.ts               assimilation commit  (7 proposable keys)
--   app/portal/profile/actions.ts         client's own profile save
--   app/(app)/clients/actions.ts          staff client edit
--
-- Between the read and the write each one is blind to the others, so whoever writes
-- second wins with a value computed from a stale snapshot and the loser's key is
-- gone. No error, no log line. The window is one request -- all three re-read at
-- write time -- so it is tens of milliseconds, not a stale open form. Narrow, not
-- closed.
--
-- The 11 DIRECT profile columns never had this problem: Postgres applies
-- column-level updates natively, so two writers touching different columns both
-- land. This is specific to the seven keys that share one jsonb column:
-- funding_need, priority_areas, mission, programs, partners, partnerships,
-- additional_info.
--
-- ── WHY IT IS WORTH A MIGRATION, AND THE ASYMMETRY THAT DECIDED IT ──
-- The two form paths lose a field someone just typed: annoying, recoverable, and
-- the person is right there to notice. The assimilation commit ADDITIONALLY writes
-- a row into client_profile_changes asserting the change happened -- and 0078 gives
-- that table no UPDATE and no DELETE policy, deliberately, because that is what
-- makes it an audit trail. So a clobbered commit leaves a PERMANENT, UNEDITABLE row
-- claiming a transition the profile does not reflect.
--
-- And it is the row rollback reads from: rollbackCommit restores old_value, so an
-- undo of a clobbered commit writes a value nobody chose. The other paths can lose
-- recoverable data; this one can make the log lie and corrupt the undo, which is
-- the mechanism the whole feature asks to be trusted for.
--
-- ── WHAT THE LOCK DOES, AND WHY `||` ALONE WOULD NOT BE ENOUGH ──
-- `select ... for update` blocks until any concurrent writer of this row has
-- COMMITTED, and then reads the committed value rather than the snapshot the
-- statement began with. That gives two properties, and the second is the reason
-- this is plpgsql instead of a one-line `set intake_data = intake_data || $1`:
--
--   1. THE MERGE IS COMPUTED FROM COMMITTED DATA. No lost keys.
--   2. THE FUNCTION CAN RETURN THE TRUE BEFORE-IMAGE. A bare `|| ` statement merges
--      correctly but cannot hand back what was there first, so the audit's
--      old_value would still be a snapshot from the top of the request -- the
--      change would take, and the log would still describe the wrong starting
--      point. Returning v_old is what makes the recorded before-image true.
--
-- SHALLOW, top-level merge -- exactly what all three call sites already hand-roll
-- with a JS spread. A key the patch omits is left alone; a key it sends replaces
-- the old one whole. narrativeToIntakeData always emits all seven keys (null for
-- empties, never undefined), so the two form paths change behaviour not at all.
--
-- `||` cannot DELETE a key. Neither could the spread, so no caller loses anything
-- it had.
--
-- NOT FIXED HERE: intellengine_drafts does the same read-modify-write on its own
-- jsonb (app/api/intellengine/drafts/[id]/route.ts, which cites the clients merge
-- as its model). Same class of bug, different table, and no audit log downstream of
-- it -- so it is its own brick, named rather than silently left.

begin;

create or replace function public.merge_client_intake(
  p_client_id uuid,
  p_patch jsonb
)
returns jsonb          -- intake_data AS IT WAS, read under the lock, for the audit
language plpgsql
-- SECURITY INVOKER, deliberately, and unlike 0068's token function. This needs no
-- elevation: it must do exactly what the caller could already do with a PATCH on
-- clients, no more. A staff caller (app/(app)/clients/actions.ts runs under the
-- caller's RLS, not the service role) passes clients_update = is_staff(); a client
-- member does not, and gets the not-found raise below rather than a silent 0-row
-- update. Keeping the policy as the gate is the point -- a definer function here
-- would move that decision out of the database and into this file.
security invoker
set search_path = public
as $$
declare
  v_old jsonb;
begin
  -- THE LOCK IS THE FIX. Also note this filters by the UPDATE policy, not just the
  -- SELECT policy: Postgres applies the UPDATE policy's USING quals to a locking
  -- read, so a caller who may read the row but not write it finds nothing here.
  select coalesce(intake_data, '{}'::jsonb)
    into v_old
    from clients
   where id = p_client_id
     for update;

  -- Louder than the alternative on purpose. A bare update against a missing or
  -- unwritable row affects zero rows and reports success, which is how a failed
  -- save looks identical to a completed one.
  if not found then
    raise exception 'merge_client_intake: client % not found or not writable', p_client_id
      using errcode = 'no_data_found';
  end if;

  update clients
     set intake_data = v_old || coalesce(p_patch, '{}'::jsonb)
   where id = p_client_id;

  return v_old;
end;
$$;

-- Callable by a logged-in user because the staff client edit runs under the
-- caller's own RLS and must keep doing so. That is not a new surface: under
-- security invoker this function can do nothing a PATCH on /clients could not
-- already do, and RLS decides both the same way. anon gets nothing.
revoke all on function public.merge_client_intake(uuid, jsonb) from public;
revoke all on function public.merge_client_intake(uuid, jsonb) from anon;
grant execute on function public.merge_client_intake(uuid, jsonb) to authenticated;
grant execute on function public.merge_client_intake(uuid, jsonb) to service_role;

insert into schema_migrations (version) values ('0079_atomic_intake_data_merge') on conflict do nothing;
commit;
