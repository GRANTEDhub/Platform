-- ╔══════════════════════════════════════════════════════════════════════════╗
-- ║ is_admin() now means MONEY. Grant work means is_staff().                  ║
-- ╚══════════════════════════════════════════════════════════════════════════╝
-- is_admin() had been carrying two unrelated meanings: "this is financial" and
-- "this is a senior action". That overload is why a contractor's blocks looked
-- arbitrary -- they could draft a whole proposal and not deliver it, edit a client
-- and not create one, and (from 0075) never touch the supporting files their own
-- drafting depends on.
--
-- After this migration the rule is one line: **is_admin() guards the financial
-- firewall and nothing else.** Everything in the drafting -> delivery path is
-- is_staff().
--
-- ── HOW TO AUDIT THAT, AND NOT BY GREPPING THIS DIRECTORY ──
-- Migration files are append-only history: a policy replaced here still appears in
-- 0001 / 0035 / 0046 forever, so `grep is_admin supabase/migrations` reports the
-- past, not the present, and would answer this question wrongly. The firewall is a
-- property of LIVE state, so audit it against live state:
--
--   select tablename, policyname, qual, with_check
--     from pg_policies
--    where schemaname = 'public'
--      and (qual like '%is_admin%' or with_check like '%is_admin%')
--    order by tablename, policyname;
--
-- Every row that comes back should be money or cold outreach:
--   invoices, contracts, time_entries, client_documents (the admin policy),
--   clients (clients_delete), prospects, lead_grant_hooks, profiles (role guard).
-- Anything else in that result is a firewall drift and wants explaining.
--
-- ── WHAT STAYS is_admin() (the firewall, unchanged by this file) ──
--   invoices, contracts, time_entries      -- 0001 / 0029
--   client_documents at ORG level          -- 0030; signed contracts live there
--   lead_grant_hooks, prospects            -- 0025 / 0028: COLD outreach to
--                                             non-clients is a brand risk held by
--                                             an admin, deliberately not widened
--   clients DELETE                         -- split out below
--
-- ── WHAT MOVES TO is_staff() ──
--   concept_proposals, grant_alerts, grants writes, clients INSERT, and the
--   approve-for-delivery gate in guard_card_approval().
--
-- SAFETY: no table, column or row is altered. Policies are replaced and one trigger
-- FUNCTION body is replaced (its binding is untouched). Every change is a widening
-- from admin to staff, so no caller loses access and no client-facing policy moves.

begin;

-- ─── 1. client_documents: pursuit files for staff, org level still admin ──────
--
-- STRUCTURAL, NOT A DENYLIST. `intellengine_draft_id is not null` IS the definition
-- of a pursuit file: the column arrived in 0075 and nothing has ever set it for a
-- contract, so every contract row is org-level and excluded by construction. A
-- `kind <> 'signed_contract'` predicate would have been a denylist that fails OPEN
-- the first time someone adds a new financial kind; this fails CLOSED for anything
-- org-level, including kinds nobody has invented yet.
--
-- `source_contract_id is null` is deliberate redundancy. Contract-derived rows are
-- already org-level, so this condition is unnecessary today -- and a firewall is
-- exactly where a second independent condition is worth its cost.
--
-- `for all`, so DELETE is included: a staffer running the drafting owns the files
-- attached to it. Org-level rows remain admin-only for every command.
--
-- This ADDS a policy. 0030's client_documents_admin is untouched, and permissive
-- policies OR together, so admin access is unchanged rather than re-derived here.
drop policy if exists client_documents_staff_pursuit on client_documents;
create policy client_documents_staff_pursuit on client_documents for all
  using (
    public.is_staff()
    and intellengine_draft_id is not null
    and source_contract_id is null
  )
  with check (
    public.is_staff()
    and intellengine_draft_id is not null
    and source_contract_id is null
  );

-- ─── 2. concept_proposals: is_staff() ────────────────────────────────────────
--
-- This one was already inconsistent with itself. app/api/concept/[cardId]/route.ts
-- states "ANY staff (admin OR contractor) -- the concept proposal is core
-- account-manager work, and our contractor IS the AM", and reaches the data via the
-- service role. The RLS said admin-only. The route's intent was right; the policy
-- is what moves.
drop policy if exists concept_proposals_admin on concept_proposals;
create policy concept_proposals_staff on concept_proposals for all
  using (public.is_staff()) with check (public.is_staff());

-- ─── 3. grant_alerts: is_staff() ─────────────────────────────────────────────
--
-- The alert draft is the delivery artifact. lib/alerts/store.ts writes it with the
-- service role today, so this is not what was blocking a send -- but leaving the
-- policy at admin-only would mean the RLS disagreed with who is now allowed to
-- deliver, and the next reader would have to guess which one was intentional.
drop policy if exists grant_alerts_admin on grant_alerts;
create policy grant_alerts_staff on grant_alerts for all
  using (public.is_staff()) with check (public.is_staff());

-- ─── 4. grants writes: is_staff() ────────────────────────────────────────────
--
-- 0046 made these admin-only. Curating grant records IS the grant work, so they
-- move. SELECT is unchanged (0001: any signed-in user).
drop policy if exists grants_insert on grants;
create policy grants_insert on grants for insert
  with check (public.is_staff());

drop policy if exists grants_update on grants;
create policy grants_update on grants for update
  using (public.is_staff()) with check (public.is_staff());

drop policy if exists grants_delete on grants;
create policy grants_delete on grants for delete
  using (public.is_staff());

-- ─── 5. clients: INSERT for staff, DELETE still admin ────────────────────────
--
-- 0001's clients_write was `for all`, so widening it as written would have handed
-- contractors DELETE along with INSERT. app/(app)/clients/actions.ts:333 already
-- decided against that -- "deleting is strictly more dangerous than creating, so it
-- is never loosened to the contractor/AM role that may edit" -- and a migration
-- should not quietly overrule a decision the application layer states out loud.
--
-- So the one `for all` policy becomes two, and only INSERT widens. UPDATE is
-- untouched: 0066 already set clients_update to is_staff().
drop policy if exists clients_write on clients;

create policy clients_insert on clients for insert
  with check (public.is_staff());

create policy clients_delete on clients for delete
  using (public.is_admin());

-- ─── 6. guard_card_approval(): approving for delivery is any staff ───────────
--
-- ⚠ THIS FUNCTION HAS BEEN REPLACED FIVE TIMES (0056 -> 0057 -> 0061 -> 0068 ->
-- 0070). The body below is 0070's, carried forward VERBATIM, with exactly one
-- change: the final staff branch is gone. Nothing else -- not the token-branch
-- column lock, not the token approve-block, not the client-member column lock, not
-- the client_read_at asymmetry -- differs by a character from 0070.
--
-- WHY THE FINAL BRANCH IS DELETED RATHER THAN WIDENED. It read:
--
--     if new.decision = 'approved'
--        and old.decision is distinct from 'approved'
--        and not public.is_admin() then
--       raise exception 'Only admins can approve a match for client delivery';
--     end if;
--
-- Widening it to `not public.is_staff()` would make it a TAUTOLOGY: the branch is
-- only reachable after the `if not public.is_staff() then ... return new; end if;`
-- above it, so is_staff() is already true there and the condition could never fire.
-- A guard that cannot fire, left in place, reads to the next person like a live
-- protection. Removing it and saying why is the honest form of the same change.
--
-- WHAT STILL GUARDS APPROVAL after this:
--   * a client member cannot reach the branch at all -- they return early, and
--     their column lock permits only the decision fields;
--   * a decision TOKEN (the alert email's Interested / Not-for-us links) is still
--     refused explicitly: "A decision link cannot approve a match for delivery".
--     That block is defence in depth and is NOT relaxed here -- an email click was
--     never the same thing as a staffer's judgement;
--   * a non-staff, non-member caller is still rejected outright.
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

insert into schema_migrations (version) values ('0077_staff_grant_work_is_staff_not_is_admin') on conflict do nothing;
commit;
