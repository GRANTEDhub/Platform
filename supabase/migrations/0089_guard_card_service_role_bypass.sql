-- 0089 — guard_card_approval(): a service-role fast-path so our own trusted backend
-- can UPDATE review_cards.
--
-- THE BUG THIS FIXES. guard_card_approval() (a BEFORE UPDATE trigger on review_cards,
-- 0002) column-locks authenticated CLIENT members and the email decision-token path.
-- It has three terminal branches: token path, client-member path, and — reached when
-- the caller is neither staff nor a member — `raise exception 'Not authorized to
-- modify this card'`. is_staff()/is_client_member_of() both key on auth.uid(), which
-- is NULL under the SERVICE ROLE (no user JWT). So EVERY service-role UPDATE of a
-- review_cards row falls into that last branch and is rejected.
--
-- That silently broke two writers, both of which use the service client on purpose:
--   * the IntellEngine QA apply-write (lib/grants/intel-queue.ts applyQaPatch) — the
--     qa_* override projection never landed; the card kept showing the engine score
--     while card_intel_reviews held a correct demote. Confirmed in prod runtime logs:
--     "[intel-apply] card …: qa_* projection failed after 3 attempts … : Not
--     authorized to modify this card".
--   * the engine's own rematch re-score UPDATE (lib/grants/pipeline.ts) — rarely hit
--     (the drain scores NEW pairs and INSERTs; the BEFORE UPDATE trigger never fires
--     on an INSERT), but when a genuine rematch of a still-pending card does fire it,
--     that UPDATE is rejected too and swallowed as a logged "Match error".
--
-- THE FIX. The service role is our own server. It already bypasses RLS on every other
-- table; the guard was never meant to gate it — 0057 disabled this very trigger for a
-- service-role bulk backfill, and 0068 built the decision-token GUC precisely because
-- "auth.uid() is null and the trigger blocks it". This makes that intent explicit: a
-- service-role caller returns NEW untouched, ahead of the token / client-member /
-- non-staff branches, which are UNCHANGED. No authenticated client actor can present
-- role='service_role' (only our backend holds the service key), so the column-lock and
-- the approve-for-delivery gate on client/token writers are not weakened.
--
-- Role detection reads the request JWT role claim directly (the JSON-blob GUC current
-- PostgREST sets, with the older per-claim GUC as a fallback) rather than the auth.role()
-- helper — self-contained, no dependency on that helper's presence or deprecation status.
-- On a direct psql/superuser connection both GUCs are unset → the check is NULL → the
-- write falls through to the existing branches exactly as before (unchanged behaviour).
--
-- The rest of the function is reproduced VERBATIM from 0077 — this migration adds only
-- the leading fast-path.
begin;

create or replace function public.guard_card_approval()
returns trigger
language plpgsql security definer set search_path = public
as $$
begin
  -- Service-role fast-path (0089). Our own trusted backend (the engine's insert/update
  -- of cards; the IntellEngine QA apply-write of the qa_* override columns) writes via
  -- the service key. The guard exists to constrain authenticated CLIENT members and the
  -- email decision-token path, never our server — which already bypasses RLS everywhere
  -- else. Let a service-role caller through untouched. See the migration header.
  if coalesce(
       nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role',
       nullif(current_setting('request.jwt.claim.role', true), '')
     ) = 'service_role' then
    return new;
  end if;

  -- Token-authenticated client decision (the alert email's Interested / Not-for-us
  -- links). current_setting(..., true) yields NULL when unset, and NULL = text is
  -- NULL, so an ordinary write simply falls through to the branches below.
  if current_setting('argo.decision_token_card', true) = new.id::text then
    -- Same column-lock the client-member branch enforces: a decision link may move
    -- the decision/interest fields and nothing else. NOT client_read_at -- see 0070.
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
    -- Defence in depth, and NOT relaxed by this migration. The function below never
    -- sets 'approved', but a decision link must not be a route around the approve
    -- gate even if it did: approving a match for client delivery is a staffer's
    -- call, not an email click.
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

  -- Any staff may approve a match for client delivery (0077). The former
  -- admin-only branch lived here; see the header for why it is deleted rather
  -- than widened.
  return new;
end;
$$;

insert into schema_migrations (version) values ('0089_guard_card_service_role_bypass') on conflict do nothing;
commit;
