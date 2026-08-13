-- ╔══════════════════════════════════════════════════════════════════════════╗
-- ║ GrantBot document artifacts — Brick 1a foundation (store only)              ║
-- ╚══════════════════════════════════════════════════════════════════════════╝
--
-- The first WRITE capability GrantBot gets: staff drafts an HTML document on
-- instruction, it persists per client, and it is edited over days/weeks across
-- sessions. This migration is the STORE ONLY -- no tools, no routes, no UI, and
-- nothing writes these tables yet. The tool loop and panel land in 1a code
-- against this schema, behind GRANTBOT_ARTIFACTS_ENABLED (default off). Formats
-- (PDF, .docx) are 1b. So, like 0075, this applies to prod changing nothing a
-- client -- or a staffer -- can yet see.
--
-- ── WHY TWO TABLES (artifact + versions), mirroring conversations/messages ──
--
-- An artifact is a document that outlives any one edit; a version is one immutable
-- snapshot of its HTML. The split is the same one 0080 made for conversation vs
-- message, and for the same reason: the thing that is edited and the record of each
-- edit have different lifetimes. Rollback is a FORWARD write of an old version's
-- html, never a destructive revert, so the whole lineage is always inspectable --
-- the append-only discipline of 0080's transcript, applied to deliverables.
--
-- ── WHY THE HTML IS INLINE, NOT IN THE BUCKET ──
--
-- The source of truth is a few KB of HTML that the panel re-renders on every open
-- and the model re-reads on every edit. Inline text is one SELECT; a bucket blob is
-- a signed-URL round-trip taxing the hottest read path for no gain. The private
-- bucket created below holds ONLY the rendered exports (PDF/.docx, 1b) -- heavy,
-- binary, and a pure function of the versioned html, so they are cached and
-- regenerable rather than authoritative. HTML in Postgres, renderings in storage.
--
-- ── WHY client_id CASCADES BUT origin_conversation_id SET NULLs ──
--
-- The artifact belongs to the CLIENT and is edited across many conversations, so it
-- must not die with the thread it was first drafted in (origin_conversation_id ->
-- set null). It does not outlive the client (client_id -> cascade), same call 0080
-- made: a conversation carries nothing that survives its client, and neither does a
-- draft deliverable.
--
-- ── kind IS FREE TEXT, NOT A CHECK CONSTRAINT ──
--
-- 0075 already made this argument for the document taxonomy: an enum in a constraint
-- forces a migration every time the set changes, and the set is exactly what is
-- still settling. Documented set today is 'concept_proposal' | 'report' | 'letter' |
-- 'html_document' (the default); widening it is a code change, not a migration.
--
-- SAFETY PROPERTIES (why this is safe to apply to prod):
--   1. Additive throughout: two NEW tables, one NEW private bucket, two NEW staff
--      SELECT policies. No existing table, column, policy, bucket or send path is
--      touched. Every statement is `if not exists` / `on conflict` / `drop policy
--      if exists`, so re-running changes nothing.
--   2. Nothing writes these tables or the bucket yet -- 1a code does, behind a
--      default-off flag. Applying this now cannot change any behaviour.
--   3. Staff SELECT only, and -- like 0080 -- NO insert/update/delete policy: every
--      write runs service-role and bypasses RLS, so no API caller can rewrite a
--      stored version. What the artifact history says was drafted is what was drafted.

begin;

-- ── 1) THE PRIVATE EXPORTS BUCKET (renderings only; HTML lives inline below) ──────
--
-- public stays false on every path. `do update set public = false` is defensive: a
-- re-run that found the bucket flipped public would correct it rather than leave it.
-- No allowed_mime_types allowlist is needed the way client-uploads (0075) needs one:
-- there, a client PUTs straight to storage over a signed upload URL, so the bucket IS
-- the only enforcement point. Here every object is written server-side under the
-- service role from html we already hold, so the bytes are ours -- a size cap is a
-- sanity backstop, not a trust boundary.
insert into storage.buckets (id, name, public, file_size_limit)
values ('grantbot-artifacts', 'grantbot-artifacts', false, 26214400) -- 25MB: generous for a multi-page PDF/.docx
on conflict (id) do update
  set public = false,
      file_size_limit = excluded.file_size_limit;

-- No storage.objects policy, on purpose -- exactly 0075's choice. Reads are served by
-- service-role signed URLs minted server-side after an is_staff() check (as the
-- contracts and client-uploads buckets do); writes are service-role. There is no path
-- that needs an authenticated storage policy, and adding one would widen access for
-- no gain.

-- ── 2) ARTIFACTS: one row per logical document, edited over time ──────────────────

create table if not exists grantbot_artifacts (
  id                     uuid primary key default uuid_generate_v4(),
  -- Owner. Cascade: a deleted client takes its draft deliverables with it.
  client_id              uuid not null references clients(id) on delete cascade,
  -- The conversation it was first drafted in (origin/audit). SET NULL, not cascade,
  -- so the artifact survives the thread -- it belongs to the client and is edited
  -- across sessions.
  origin_conversation_id uuid references grantbot_conversations(id) on delete set null,
  -- Documented set: 'concept_proposal' | 'report' | 'letter' | 'html_document'.
  -- Free text on purpose (see header); default is the generic kind.
  kind                   text not null default 'html_document',
  title                  text not null,
  -- Head pointer into grantbot_artifact_versions.version. 0 = no version written yet.
  current_version        integer not null default 0,
  -- Forward-provision: hide-without-destroy for a superseded deliverable. NOT written
  -- by 1a code (0080's "column before the feature, no migration later" philosophy).
  archived_at            timestamptz,
  created_by             uuid,
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now()
);

create index if not exists grantbot_artifacts_client_idx
  on grantbot_artifacts (client_id, updated_at desc);

-- ── 3) VERSIONS: one immutable snapshot per edit ─────────────────────────────────

create table if not exists grantbot_artifact_versions (
  id                     uuid primary key default uuid_generate_v4(),
  artifact_id            uuid not null references grantbot_artifacts(id) on delete cascade,
  -- 1-based, monotonic per artifact. Rollback writes a NEW version cloning an old
  -- one's html; it never rewinds this number.
  version                integer not null,
  -- The DOCUMENT-sanitized HTML source of truth. Inline (see header): KB-scale, and
  -- the panel/model read it on every open/edit.
  html                   text not null,
  -- The model's one-line "what changed", for the version list / rollback UI.
  summary                text,
  -- The turn that produced this version. SET NULL so a pruned message never orphans
  -- the deliverable it drafted.
  produced_by_message_id uuid references grantbot_messages(id) on delete set null,
  created_by             uuid,
  created_at             timestamptz not null default now()
);

-- One row per (artifact, version): makes a double-submit a constraint violation
-- rather than two rows claiming the same version. Same guard as 0080's seq index.
create unique index if not exists grantbot_artifact_versions_unique
  on grantbot_artifact_versions (artifact_id, version);

create index if not exists grantbot_artifact_versions_artifact_idx
  on grantbot_artifact_versions (artifact_id, version desc);

-- ── 4) RLS: STAFF READ, NO CLIENT READ, NO WRITE POLICY ──────────────────────────
--
-- Same discipline as 0080's grantbot tables. Staff SELECT only -- these are internal
-- staff deliverables-in-progress, and (like the transcript) there is deliberately NO
-- is_client_member_of() policy: a draft is staff voice about the client until a human
-- chooses to send a rendered copy, which is a separate act, not a table read. NO
-- insert/update/delete policy: every write goes through the service-role artifact
-- store, which bypasses RLS, so no API caller can rewrite or delete a stored version.

alter table grantbot_artifacts enable row level security;
alter table grantbot_artifact_versions enable row level security;

drop policy if exists grantbot_artifacts_staff_select on grantbot_artifacts;
create policy grantbot_artifacts_staff_select on grantbot_artifacts for select
  using (public.is_staff());

drop policy if exists grantbot_artifact_versions_staff_select on grantbot_artifact_versions;
create policy grantbot_artifact_versions_staff_select on grantbot_artifact_versions for select
  using (public.is_staff());

-- NOTE for a FUTURE delete route (not in Brick 1): deleting an artifact cascades its
-- version rows, which would orphan any rendered exports (1b) in the bucket -- the same
-- obligation 0075 recorded for draft deletion. A delete route must collect and remove
-- the artifact's bucket objects first. Brick 1 has no delete (append-only + archive),
-- so the obligation is deferred, recorded here where the cascade is defined.

insert into schema_migrations (version) values ('0082_grantbot_artifacts') on conflict do nothing;

commit;
