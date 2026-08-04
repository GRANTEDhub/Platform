-- ╔══════════════════════════════════════════════════════════════════════════╗
-- ║ One-click grant decisions from the alert email                            ║
-- ╚══════════════════════════════════════════════════════════════════════════╝
-- An account-managed client gets a released grant as an email + PDF one-pager.
-- Today the only way to answer is to sign in and swipe the card in Grant Alerts,
-- which means reading the same grant summary twice. This lets them answer from
-- the email: "Interested" moves it into their Grant Report, "Not for us" passes.
--
-- THE PROBLEM THIS MIGRATION EXISTS TO SOLVE. guard_card_approval() has exactly
-- two doors: is_staff(), or is_client_member_of(new.client_id). Both read
-- auth.uid(). A tokenized email click is UNAUTHENTICATED by design -- not making
-- them sign in is the entire point -- so auth.uid() is null and the trigger
-- refuses the write with 'Not authorized to modify this card'. The service role
-- does not help: it also has a null auth.uid(), which is why the recall route
-- deliberately writes through the USER client. So a decision link cannot work
-- without a third door.
--
-- THE THIRD DOOR IS A NOTE, NOT A MASTER KEY. The rejected alternative was to let
-- the trigger wave through anything holding the service role. That is one line,
-- and it turns a deliberate guard off for an entire class of caller: every
-- present and future service-role write to review_cards would skip the
-- column-lock AND the admin-only approve gate. Instead, the write must carry a
-- transaction-local note naming the ONE card it may touch
-- (argo.decision_token_card). Anything without the note is refused exactly as
-- before.
--
-- AND THE NOTE IS ONLY OBTAINABLE HERE. set_config() is not reachable over
-- PostgREST, so the app cannot set the GUC itself; the only code that can is
-- record_card_decision_by_token() below, which sets it AFTER resolving a valid,
-- unexpired token to a real card. Doing the whole thing inside one plpgsql
-- function is also what makes it atomic -- two REST calls would be two separate
-- transactions and a transaction-local setting would not survive between them.
--
-- Reuses the 0022 token layer as designed: access_tokens is polymorphic with
-- client_id already documented as "reserved for future client-portal tokens",
-- grant_id is present, and action_type is extensible with no CHECK. No new table
-- and no new column -- the alert has a single recipient (sendGrantAlertEmail
-- takes one address) and the card already records sent_to, so there is nothing
-- per-recipient left to store.

begin;

-- ── guard_card_approval: 0061's body VERBATIM plus a leading token branch. The
--    client-member branch and the staff admin-approve gate are byte-for-byte
--    unchanged; the token branch has to come FIRST because the non-staff branch
--    raises immediately and would never fall through to it. ──
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
    -- the decision/interest fields and nothing else.
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

-- ── record_card_decision_by_token: resolve token -> card, set the note, write. ──
--
-- The token hash is computed in the app (lib/tokens.ts hashToken) and passed in,
-- matching how resolveToken already reads it -- the raw token never reaches the
-- database, exactly as 0022 intended.
--
-- TWO ACTIONS, EACH THE OTHER'S REVERSE, both idempotent:
--   'interested'  -> in their Grant Report, undecided. Clears any prior pass, so
--                    a mis-click on "Not for us" is undone by clicking Interested.
--   'pass'        -> decision='passed'. Leaves interested_at alone: whether they
--                    ever looked is a fact about the past, not part of the answer.
-- Neither ever writes 'approved' (see the trigger's second guard).
--
-- Returns jsonb rather than raising, so the landing page can say WHICH thing went
-- wrong -- an expired link and a deleted card need different sentences, and a
-- 500 page would say neither.
create or replace function public.record_card_decision_by_token(
  p_token_hash text,
  p_action     text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_token   public.access_tokens;
  v_card_id uuid;
  v_title   text;
  v_client  text;
begin
  if p_action not in ('interested', 'pass') then
    return jsonb_build_object('ok', false, 'error', 'unknown_action');
  end if;

  select * into v_token
    from public.access_tokens
   where token_hash = p_token_hash
     and action_type = 'client_alert_decision'
   limit 1;
  if not found then
    return jsonb_build_object('ok', false, 'error', 'invalid_token');
  end if;
  if v_token.expires_at <= now() then
    return jsonb_build_object('ok', false, 'error', 'expired');
  end if;
  if v_token.client_id is null or v_token.grant_id is null then
    return jsonb_build_object('ok', false, 'error', 'invalid_token');
  end if;

  -- (client_id, grant_id) identifies the card: review_cards is unique on the pair.
  -- Prospect cards are excluded -- they are not part of a client's book, and a
  -- prospect has no portal decision to record.
  select rc.id into v_card_id
    from public.review_cards rc
   where rc.client_id = v_token.client_id
     and rc.grant_id  = v_token.grant_id
     and rc.card_type is distinct from 'prospect'
   limit 1;
  if v_card_id is null then
    return jsonb_build_object('ok', false, 'error', 'card_not_found');
  end if;

  -- The note for the guard. `true` = transaction-local, so it evaporates when this
  -- function's transaction ends: it cannot leak into a later statement, cannot be
  -- replayed, and cannot be picked up by unrelated code.
  perform set_config('argo.decision_token_card', v_card_id::text, true);

  if p_action = 'interested' then
    update public.review_cards
       set interested_at       = coalesce(interested_at, now()),
           interested_by_actor = 'client_email',
           decision            = 'pending',
           decision_reason     = null,
           decided_at          = null,
           decided_by          = null,
           decided_by_actor    = null
     where id = v_card_id;
  else
    update public.review_cards
       set decision         = 'passed',
           decision_reason  = null,
           decided_at       = now(),
           decided_by       = null,
           decided_by_actor = 'client_email'
     where id = v_card_id;
  end if;

  select g.title into v_title from public.grants  g where g.id = v_token.grant_id;
  select c.name  into v_client from public.clients c where c.id = v_token.client_id;

  return jsonb_build_object(
    'ok', true,
    'action', p_action,
    'card_id', v_card_id,
    'client_id', v_token.client_id,
    'grant_id', v_token.grant_id,
    'grant_title', v_title,
    'client_name', v_client,
    'token_id', v_token.id
  );
end;
$$;

-- Service role only. The landing page is unauthenticated so it must call this
-- through the service client anyway; revoking the rest means a logged-in user
-- cannot reach the guard's third door even with a token hash in hand.
revoke all on function public.record_card_decision_by_token(text, text) from public;
revoke all on function public.record_card_decision_by_token(text, text) from anon;
revoke all on function public.record_card_decision_by_token(text, text) from authenticated;
grant execute on function public.record_card_decision_by_token(text, text) to service_role;

insert into schema_migrations (version) values ('0068_card_decision_by_token') on conflict do nothing;
commit;
