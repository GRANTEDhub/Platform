-- ╔══════════════════════════════════════════════════════════════════════════╗
-- ║ GrantBot brick 2: the conversation store, plus a generation date for the    ║
-- ║ distilled profile.                                                          ║
-- ╚══════════════════════════════════════════════════════════════════════════╝
--
-- The platform has had 14 Anthropic call sites for a year and not one row of conversation
-- state: every call is single-shot, tool-forced and stateless. This is the first stored
-- dialogue, so the shape decisions here are the ones that are expensive to change later.
--
-- ── WHY content IS jsonb AND NOT text ──
--
-- A message is not a string. Today it is one text block; the moment GrantBot gains a tool,
-- a retrieved skill, an image, or a document reference, a turn becomes an ARRAY of typed
-- blocks and that is what has to round-trip to reconstruct the conversation for the next
-- request. A text column would force either a lossy re-render (the model receives something
-- different from what it produced) or a migration plus a backfill of every historical row.
-- jsonb costs nothing today and removes that migration entirely. Same reasoning that put
-- old_value/new_value in jsonb in 0078.
--
-- ── WHY context_blocks EXISTS: "WHAT WERE WE TELLING IT?" ──
--
-- When an answer is wrong three weeks from now, the first question is what the model was
-- looking at. The versions alone do not answer it -- the client's context pack is assembled
-- live from 20+ columns and changes under us, and a future retrieval step will vary the
-- blocks per turn. So each assistant row records the MANIFEST of what was in front of the
-- model: one entry per prompt block with its kind, source, version and size.
--
-- THE MANIFEST, NOT THE BYTES. Storing the assembled prompt would be a few thousand
-- characters on every single turn, most of it identical to the turn before, to preserve
-- something reproducible from the versions plus the pack. The manifest is the part that is
-- not recoverable.
--
--   [{"kind":"guardrails","source":"instructions.ts","version":"2026-08-11.1","chars":5085},
--    {"kind":"methodology","source":"methodology.ts","version":"2026-08-12.1","chars":8k},
--    {"kind":"client-context","source":"context-pack","version":null,"chars":14203}, ...]
--
-- When a retrieved skill becomes a block, it lands in this column with no migration and no
-- backfill. That is the whole point of the column existing before the feature does.
--
-- ── WHY usage IS STORED ──
--
-- Prompt caching is load-bearing for this feature, not an optimisation: a full context pack
-- sits in front of every turn. Whether the cache is actually being READ is invisible from
-- the outside and shows up in exactly one place, the response's cache_read_input_tokens. A
-- prefix that silently stopped matching would look identical from the UI and cost ~10x per
-- turn. Stored so the question is answerable from SQL instead of inferred.

begin;

-- ── 1. THE DISTILLED PROFILE FINALLY GETS A DATE ──
--
-- clients.client_profile is an LLM distillation with no generation date anywhere in the
-- schema, which the context pack has been reporting as a gap in its own words: "carries NO
-- generation date (no such column exists)". Its age matters more than most columns' -- it is
-- the `derived` provenance tier, the one GrantBot is instructed to distrust, and MSET's
-- carried a different organisation's legal name.
--
-- A SIBLING COLUMN, NOT A KEY INSIDE THE jsonb. Follows the convention already used five
-- times over (nonprofit_finance/_checked_at, sam_matched_name/sam_checked_at,
-- description_brief/_at): the date is typed, indexable, and cannot be dropped by a writer
-- that rebuilds the jsonb wholesale -- which is exactly what refreshClientProfileById does.
--
-- DELIBERATELY NOT BACKFILLED. No honest value exists for the 19 rows that already have a
-- profile; we do not know when they were distilled. A backfill to now() would be a
-- fabricated timestamp on the one tier of data the whole design tells the model to doubt.
-- Null stays null and the gaps list says "predates the column" rather than "no such column",
-- which is a smaller and more accurate absence. #348's enrich-after-commit fills it forward.
alter table clients add column if not exists client_profile_generated_at timestamptz;

comment on column clients.client_profile_generated_at is
  'When client_profile was last DISTILLED (refreshClientProfileById). Not touched by the '
  'community-context-only patch, which rewrites the jsonb without re-running the model.';

-- ── 2. CONVERSATIONS ──

create table if not exists grantbot_conversations (
  id                uuid primary key default uuid_generate_v4(),
  -- ONE CLIENT PER CONVERSATION, enforced by the column rather than by prompt discipline.
  -- GrantBot's whole context is one client's pack; a thread that could switch clients
  -- mid-way would be a thread whose earlier turns were answered from a different org's
  -- facts. Cascade: deleting a client removes its conversations, which contain nothing that
  -- outlives it (unlike the profile audit, which deliberately survives its document).
  client_id         uuid not null references clients(id) on delete cascade,
  -- First user message, truncated, so the list is readable without opening each thread.
  -- Written once at creation; not a user-editable name in v1.
  title             text,
  started_by        uuid,
  started_by_email  text,
  created_at        timestamptz not null default now(),
  -- Denormalised for ordering the list without aggregating messages on every render.
  last_message_at   timestamptz not null default now()
);

create index if not exists grantbot_conversations_client_idx
  on grantbot_conversations (client_id, last_message_at desc);

-- ── 3. MESSAGES ──

create table if not exists grantbot_messages (
  id                   uuid primary key default uuid_generate_v4(),
  conversation_id      uuid not null references grantbot_conversations(id) on delete cascade,
  role                 text not null,
  -- Anthropic content blocks. See the header: a message is an array of typed blocks, and
  -- what round-trips into the next request has to be what the model actually produced.
  content              jsonb not null,
  -- Ordering WITHIN a conversation. created_at is not enough: two rows written in the same
  -- transaction (the user turn and its answer) can share a timestamp, and "which came
  -- first" is not a detail in a conversation -- it is the conversation.
  seq                  integer not null,

  -- ── WHAT THE MODEL WAS LOOKING AT (assistant rows) ──
  -- The block manifest. Null on user rows.
  context_blocks       jsonb,
  instructions_version text,
  methodology_version  text,
  model                text,
  -- input_tokens, output_tokens, cache_read_input_tokens, cache_creation_input_tokens.
  usage                jsonb,
  stop_reason          text,
  -- A FAILED TURN IS STILL A TURN. When the API call errors the row is written anyway with
  -- the reason, because a conversation that silently drops its failures reads as though the
  -- staffer never asked -- and "it didn't answer me" is precisely the report that needs a
  -- row to look at.
  error                text,
  created_at           timestamptz not null default now()
);

alter table grantbot_messages drop constraint if exists grantbot_messages_role_chk;
alter table grantbot_messages add constraint grantbot_messages_role_chk
  check (role in ('user', 'assistant'));

-- One seq per conversation. Makes a double-submit a constraint violation rather than two
-- rows claiming the same position.
create unique index if not exists grantbot_messages_seq_idx
  on grantbot_messages (conversation_id, seq);

-- ── 4. RLS: STAFF READ, NO CLIENT READ AT ALL ──

alter table grantbot_conversations enable row level security;
alter table grantbot_messages enable row level security;

-- STAFF-ONLY, and unlike client_profile_changes (0078) there is deliberately NO
-- is_client_member_of() policy on either table. That table holds the client's own profile
-- values, so showing it to them costs nothing. These tables hold internal staff dialogue
-- about the client -- go/no-go reasoning, competitive reads, "this isn't a real fit" -- and
-- the pack GrantBot works from includes the INTERNAL staff-notes section. A client-member
-- read policy here would publish staff voice to the client. There is no such policy, so it
-- cannot happen by a later mistake in application code.
drop policy if exists grantbot_conversations_staff_select on grantbot_conversations;
create policy grantbot_conversations_staff_select on grantbot_conversations for select
  using (public.is_staff());

drop policy if exists grantbot_messages_staff_select on grantbot_messages;
create policy grantbot_messages_staff_select on grantbot_messages for select
  using (public.is_staff());

-- ── NO INSERT, UPDATE OR DELETE POLICY, same discipline as 0078. ──
-- Every write goes through the service-role turn route, which bypasses RLS. Nobody can
-- rewrite a stored answer through the API, so what the transcript says GrantBot said is what
-- GrantBot said. v1 consequence, accepted knowingly: a staffer cannot delete or rename a
-- thread from the UI. Adding that later is a policy plus a route, not a reshape.

insert into schema_migrations (version) values ('0080_grantbot_conversations') on conflict do nothing;

commit;
