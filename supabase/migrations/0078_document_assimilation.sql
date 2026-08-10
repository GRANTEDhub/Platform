-- ╔══════════════════════════════════════════════════════════════════════════╗
-- ║ Document assimilation: extraction on the document, an append-only audit    ║
-- ╚══════════════════════════════════════════════════════════════════════════╝
-- The document model is ASSIMILATION, not filing (docs/pursuit-state-audit-2026-08.md
-- §5.1, superseding the 3d repository plan). A document is uploaded, extracted into a
-- structured summary, a human reviews the profile changes it proposes, and commits.
-- The extracted text is what feeds the profile; the raw file is retained only so
-- extraction can be re-run against the source, never surfaced as a repository.
--
-- This migration adds the two places that has to live: the extraction, on the document
-- row it came from; and the record of every committed change, in its own table.
--
-- ── WHAT THIS DOES NOT DO ──
-- No policy on client_documents changes. No column becomes client-readable that was not
-- already. Visibility is still governed entirely by 0075's client_visible (and the
-- caller-intent rule added to the confirm route), so a retained extraction source stays
-- invisible to clients by default.

begin;

-- ─── 1. Extraction, on the document ──────────────────────────────────────────
--
-- extraction_status EARNS ITS PLACE rather than being derivable. A tolerant reader
-- cannot tell "never run" from "ran and found nothing" from "failed" if `{}` is the only
-- signal -- and a failure that reads as an empty document is exactly the silent-drop
-- shape this whole track has been removing. 'stale' exists for a document whose source
-- was re-uploaded after an extraction.
--
-- extraction_error makes a failure SAYABLE. Excel is the known case: the upload
-- allowlist accepts .xls/.xlsx and there is no spreadsheet parser in the dependency
-- tree, so those fail here honestly with a message instead of silently yielding nothing.
--
-- THE DOCUMENT DATE IS DELIBERATELY NOT A COLUMN. It lives inside `extracted`, because a
-- top-level `doc_date` reads as a fact and an extracted date is a CLAIM about the
-- client's document until a human accepts it -- the same rule award amounts follow. Only
-- a committed value ever reaches the profile.
alter table client_documents
  add column if not exists extraction_status text not null default 'pending',
  add column if not exists extracted         jsonb not null default '{}'::jsonb,
  add column if not exists extracted_at      timestamptz,
  add column if not exists extraction_error  text,
  -- The reviewer's own note, offered beside the extracted summary. Lives on the document
  -- because it is about the document, and is COPIED into each audit row at commit so the
  -- log is self-contained and survives the document being deleted.
  add column if not exists review_note       text;

-- Only sane values, and 'pending' is the default so every existing row is already valid.
alter table client_documents drop constraint if exists client_documents_extraction_status_chk;
alter table client_documents add constraint client_documents_extraction_status_chk
  check (extraction_status in ('pending', 'ready', 'failed', 'stale'));

-- The review queue's own read: documents extracted and awaiting a human.
create index if not exists client_documents_extraction_idx
  on client_documents (client_id, extraction_status);

-- ─── 2. The audit trail ──────────────────────────────────────────────────────
--
-- Both clients and staff may commit -- no approval bottleneck -- so the trail is what
-- makes that safe: every committed change is attributable and reversible.
--
-- ONE ROW PER FIELD, grouped by commit_id. Per-field makes rolling back a single field
-- trivial and "who last changed mission" a one-line query; commit_id still pulls back a
-- whole sitting. A single row carrying a jsonb diff would turn per-field rollback into a
-- parsing exercise.
--
-- committed_by IS NOT A profiles FK, and this is not an oversight. A client member has no
-- profiles row -- which is exactly why the confirm route writes created_by: null for a
-- client upload rather than violating that FK -- and clients commit here. So the actor is
-- the auth user id, with email and kind SNAPSHOT at commit time: "who changed this" has
-- to stay answerable after a membership is deleted. Same shape pipeline_events (0022)
-- already uses for its subject_snapshot.
--
-- jsonb VALUES, not text. priority_areas and programs are arrays, partners is an array of
-- objects; storing them as text would make rollback lossy.
create table if not exists client_profile_changes (
  id                 uuid primary key default uuid_generate_v4(),
  -- Groups the fields committed together in one review.
  commit_id          uuid not null,
  client_id          uuid not null references clients(id) on delete cascade,
  -- SET NULL, not cascade: deleting the source document must not erase the record of what
  -- it changed. The audit outlives its cause.
  document_id        uuid references client_documents(id) on delete set null,
  -- 'mission' | 'primary_contact_email' | 'intake_data.programs' ... The app validates
  -- against its own allowlist (lib/documents/proposal.ts); free text here so a widening
  -- needs no migration, matching the `kind` convention from 0030.
  field              text not null,
  old_value          jsonb,
  new_value          jsonb,
  committed_by       uuid,
  committed_by_email text,
  committed_by_kind  text not null,
  -- Copied from client_documents.review_note at commit time.
  note               text,
  committed_at       timestamptz not null default now()
);

alter table client_profile_changes drop constraint if exists client_profile_changes_kind_chk;
alter table client_profile_changes add constraint client_profile_changes_kind_chk
  check (committed_by_kind in ('client', 'staff'));

create index if not exists client_profile_changes_client_idx
  on client_profile_changes (client_id, committed_at desc);
create index if not exists client_profile_changes_commit_idx
  on client_profile_changes (commit_id);
create index if not exists client_profile_changes_document_idx
  on client_profile_changes (document_id);

alter table client_profile_changes enable row level security;

-- STAFF READ, not admin-only. This is not financial data, so it follows 0077's rule --
-- is_admin() guards money and nothing else.
drop policy if exists client_profile_changes_staff_select on client_profile_changes;
create policy client_profile_changes_staff_select on client_profile_changes for select
  using (public.is_staff());

-- CLIENT READS THEIR OWN HISTORY. The rows contain only that org's own profile values, so
-- there is nothing here they are not entitled to, and seeing what changed on their own
-- profile is transparency at no cost.
drop policy if exists client_profile_changes_member_select on client_profile_changes;
create policy client_profile_changes_member_select on client_profile_changes for select
  using (public.is_client_member_of(client_id));

-- ── NO INSERT, UPDATE OR DELETE POLICY. THAT IS THE FEATURE. ──
-- Writes go through the service-role commit path. With no UPDATE or DELETE policy at all,
-- nobody -- client, contractor or admin -- can rewrite or quietly remove history through
-- RLS. The log is append-only by construction rather than by convention, which is what
-- makes "I can always audit and roll back" a property instead of a promise.
--
-- Rollback is therefore a FORWARD commit: re-applying an old value writes NEW rows, so
-- "was this rolled back" stays answerable. Nothing is ever erased.

insert into schema_migrations (version) values ('0078_document_assimilation') on conflict do nothing;
commit;
