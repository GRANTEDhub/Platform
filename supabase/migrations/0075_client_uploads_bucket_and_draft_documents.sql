-- ╔══════════════════════════════════════════════════════════════════════════╗
-- ║ client-uploads bucket + draft-scoped documents — Pursuit step 3a            ║
-- ╚══════════════════════════════════════════════════════════════════════════╝
-- Chunk 3a of the document layer (docs/pursuit-state-audit-2026-08.md §5.1). The
-- FOUNDATION only: a bucket, two columns, one policy, and generalised storage
-- helpers. No routes and no UI, so nothing a client can see changes here. The
-- upload path is 3b.
--
-- WHY A NEW BUCKET RATHER THAN 'contracts'. That bucket is a legal-record store
-- whose whole contract is "service role only, no authenticated policy, admins get
-- signed URLs" (0030). Client uploads are a different thing with different limits
-- and a different audience, and mixing them would make the contracts bucket's rule
-- untrue by association.
--
-- LIMITS LIVE ON THE BUCKET, and that is the point of putting them here. Uploads
-- arrive via a SIGNED UPLOAD URL: the client PUTs straight to storage, so our route
-- never sees the bytes and cannot check them. A client can claim any content type
-- it likes in the request; file_size_limit and allowed_mime_types are enforced by
-- storage itself, which makes this the only place the check actually holds.
--
-- DOCUMENTS ONLY, NO IMAGES, deliberately. A phone photo of a board list is not an
-- artifact we want inside a proposal package. image/jpeg and image/png can be added
-- later if clients turn out to need them -- widening a mime allowlist is a one-line
-- migration, and narrowing one after clients have uploaded is not.
--
-- SAFETY PROPERTIES (why this is safe to apply to prod):
--   1. Additive throughout: a new bucket, two nullable/defaulted columns, one new
--      SELECT policy. No existing column, policy, trigger, matcher or send path is
--      modified. Every statement is `if not exists` / `on conflict` / `drop policy
--      if exists`, so re-running changes nothing.
--   2. The new policy grants access to ZERO existing rows. It requires
--      client_visible, which defaults to false, so every row already in the table --
--      all of them kind='signed_contract' -- stays invisible to clients with no
--      backfill and no enumeration of kinds.
--   3. The 'contracts' bucket and its service-role-only access are untouched.
--   4. Nothing writes the new column or bucket yet. 3b adds the routes.

begin;

-- ── 1) The bucket ────────────────────────────────────────────────────────────────
--
-- `on conflict do update` where 0030 used `do nothing`, and that difference is
-- deliberate: these limits ARE the enforcement, so a re-run finding a drifted bucket
-- must correct it rather than silently leave a widened one in place. public stays
-- false on every path.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'client-uploads',
  'client-uploads',
  false,
  26214400, -- 25MB. Comfortably fits a scanned audit; well under any single-object concern.
  array[
    'application/pdf',
    'application/msword',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'application/vnd.ms-excel',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
  ]
)
on conflict (id) do update
  set public = false,
      file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

-- No storage.objects policy is added, on purpose. Reads go through service-role
-- signed URLs exactly as the contracts bucket does, and writes arrive on a signed
-- upload URL minted server-side after a membership check -- so there is no path that
-- needs an authenticated storage policy, and adding one would widen access for no
-- gain.

-- ── 2) One repository, two kinds of document ──────────────────────────────────────
--
-- null              = ORG-LEVEL: a staff-owned firm record (990, audit, board list).
--                     Reusable across every pursuit. Not client-deletable.
-- intellengine_draft_id set = that DRAFT's own supporting file (this pursuit's budget,
--                     a prior proposal). The client's to remove.
--
-- The nullability IS the discriminator, so no extra "owner" column is needed: 3b's
-- delete route permits a client to remove a row only when this is non-null.
--
-- ON DELETE CASCADE, WITH A CONSEQUENCE 3B MUST HONOUR. Deleting a draft removes its
-- document ROWS, which would leave their storage OBJECTS orphaned -- the existing
-- draft-delete route knows nothing about storage. 3b therefore has to collect the
-- storage paths before deleting a draft, exactly as app/(app)/clients/actions.ts
-- already does for client deletion. Recorded here because this schema choice is what
-- creates that obligation.
alter table client_documents
  add column if not exists intellengine_draft_id uuid
    references intellengine_drafts(id) on delete cascade;

-- ── 3) Client visibility, failing closed ─────────────────────────────────────────
--
-- WHY A BOOLEAN AND NOT A KIND PREDICATE. The obvious member policy is a denylist,
-- `kind <> 'signed_contract'`, and it fails OPEN: the next kind nobody thinks about
-- -- 0030's own comment already anticipates roadmaps and reports -- becomes
-- client-readable by default. That is the same incident as a blanket policy, arriving
-- later by omission instead of by commission.
--
-- An allowlist of kinds fails closed but has to be spelled out in the policy, which
-- means a migration every time the taxonomy changes -- and the taxonomy is exactly
-- what is still being settled.
--
-- A boolean defaulting to false fails closed by construction, is independent of the
-- kind list, and reduces the policy to one auditable term. If a staffer forgets to
-- set it the client cannot see their own 990, which is the harmless direction to be
-- wrong in.
alter table client_documents
  add column if not exists client_visible boolean not null default false;

create index if not exists client_documents_draft_idx
  on client_documents(intellengine_draft_id)
  where intellengine_draft_id is not null;

-- ── 4) The member grant: SELECT, and nothing else ────────────────────────────────
--
-- Members never write this table. Uploads are inserted by the 3b route under the
-- service role after it has verified membership, so INSERT/UPDATE/DELETE for members
-- would be granting a capability nothing uses -- and every unused grant is a hole
-- someone can find later. The admin policy from 0030 is untouched and still governs
-- staff access to everything, signed contracts included.
drop policy if exists client_documents_member_select on client_documents;
create policy client_documents_member_select on client_documents for select
  using (public.is_client_member_of(client_id) and client_visible);

insert into schema_migrations (version) values ('0075_client_uploads_bucket_and_draft_documents') on conflict do nothing;
commit;
