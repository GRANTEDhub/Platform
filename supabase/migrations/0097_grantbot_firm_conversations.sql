-- ╔══════════════════════════════════════════════════════════════════════════╗
-- ║ GrantBot Firm — Memory (Brick 2): let a conversation belong to the FIRM,    ║
-- ║ not a client, so the firm bot's threads persist across sessions.            ║
-- ╚══════════════════════════════════════════════════════════════════════════╝
--
-- The firm GrantBot (0080's sibling, added by #537/#540) was EPHEMERAL by construction: it had
-- nowhere to store a thread, because grantbot_conversations.client_id is NOT NULL and a firm thread
-- has no client. This migration removes that single blocker, reusing the EXISTING conversation +
-- message tables rather than forking a parallel pair.
--
-- ── WHY REUSE THE TABLES, NOT NEW ONES ──
--
-- The end-state (the Switcher brick) is ONE GrantBot with firm + client threads in a single
-- switchable list. Nullable client_id + a scope discriminator IS that shape: a firm thread and a
-- client thread are the same row type, told apart by `scope`, listed by the same store. Separate
-- grantbot_firm_* tables would fork the store layer and force the Switcher to union two table sets
-- — the exact duplication the firm-bot build avoided by keeping firm a sibling, not a fork. The
-- message table is untouched: a message already belongs to a conversation, not a client.
--
-- ── WHY A scope COLUMN AND A CHECK, NOT JUST client_id IS NULL ──
--
-- "Firm = client_id is null" would work as a marker, but it leaves the invariant unenforced: a bug
-- could write a firm thread WITH a client_id, or strip the client_id off a client thread, and
-- nothing would catch it. The scope column names the intent explicitly (the Switcher filters on it,
-- not on a null test), and the CHECK makes the pairing a database invariant — the 0080 ethos of
-- enforcing by the column rather than by application discipline. Existing rows all have a client_id
-- and default to scope 'client', so the constraint holds on the whole table at creation with no
-- backfill.
--
-- ── RLS IS UNCHANGED, AND THAT IS CORRECT ──
--
-- 0080's staff-SELECT policy is `using (public.is_staff())` with NO client_id predicate, so it
-- already covers firm rows (client_id null) exactly as it covers client rows. There is still NO
-- client-member SELECT policy (firm threads are firm-internal staff strategy, never client-facing —
-- the same reason 0080 withholds it for client threads), and still NO insert/update/delete policy,
-- so every firm write runs service-role through the staff-gated firm turn/rename routes and no API
-- caller can rewrite a stored answer. The append-only-transcript invariant carries over untouched.
--
-- ── SAFETY OF THE NULLABILITY LOOSENING ──
--
-- Every per-client query filters `client_id = <id>` (createConversation/listConversations/
-- updateConversationTitle in store.ts), which EXCLUDES the new client_id-null firm rows; every firm
-- query filters `scope = 'firm'`. The two never see each other's rows. The client-delete cascade is
-- unaffected — a firm row has no client to cascade from.

begin;

-- 1. A firm thread has no client. This is the whole blocker; everything else here is guardrail.
alter table grantbot_conversations alter column client_id drop not null;

-- 2. The scope discriminator. Defaults to 'client' so every existing row is unchanged and any
--    writer that predates this column keeps producing client threads.
alter table grantbot_conversations add column if not exists scope text not null default 'client';

alter table grantbot_conversations drop constraint if exists grantbot_conversations_scope_chk;
alter table grantbot_conversations add constraint grantbot_conversations_scope_chk
  check (
    (scope = 'client' and client_id is not null) or
    (scope = 'firm'   and client_id is null)
  );

comment on column grantbot_conversations.scope is
  'client = one client''s thread (client_id set); firm = the firm-wide GrantBot''s thread '
  '(client_id null). Enforced paired by grantbot_conversations_scope_chk.';

-- 3. Listing firm threads is "scope=firm, newest first". A partial index keeps that off the
--    client rows entirely — the firm list never scans the (much larger) client-thread space, and
--    the existing (client_id, last_message_at) index still serves the per-client list.
create index if not exists grantbot_conversations_firm_idx
  on grantbot_conversations (last_message_at desc)
  where scope = 'firm';

insert into schema_migrations (version) values ('0097_grantbot_firm_conversations') on conflict do nothing;

commit;
