-- ╔══════════════════════════════════════════════════════════════════════════╗
-- ║ P4 chunk 2 — signed-PDF storage + reusable client document repository        ║
-- ╚══════════════════════════════════════════════════════════════════════════╝
-- Two additions:
--   1) A PRIVATE 'contracts' storage bucket for the signed-PDF artifact. Private
--      (public=false) because it is a legal record: it must never be publicly
--      readable. Uploads and downloads go through the SERVICE role (which bypasses
--      storage RLS); admins receive short-lived SIGNED URLs generated server-side.
--      No anon/authenticated storage policy is added, so nothing but the service
--      role can reach the objects.
--   2) client_documents — a reusable per-client document repository (admin-only
--      RLS, financial-firewall pattern). The signed contract inserts one row
--      (kind='signed_contract'); future doc types (roadmaps, reports) reuse it via
--      a different kind. Keyed by client_id, so it carries across lead->client
--      conversion (same row/id) with zero migration.

-- 1) Private storage bucket for signed contract PDFs.
insert into storage.buckets (id, name, public)
values ('contracts', 'contracts', false)
on conflict (id) do nothing;

-- 2) Reusable client document repository.
create table if not exists client_documents (
  id                 uuid primary key default uuid_generate_v4(),
  client_id          uuid not null references clients(id) on delete cascade,
  kind               text not null,                       -- 'signed_contract' (extensible; validated in app)
  title              text not null,
  storage_bucket     text not null default 'contracts',
  storage_path       text not null,                       -- object path within the bucket (never a public URL)
  content_type       text,
  size_bytes         integer,
  source_contract_id uuid references contracts(id) on delete set null,
  created_by         uuid references profiles(id) on delete set null,
  created_at         timestamptz not null default now()
);
create index if not exists client_documents_client_idx on client_documents (client_id);

-- Admin-only RLS. The signing write path inserts via the service role (bypasses
-- RLS), gated by the signing token -- not by RLS.
alter table client_documents enable row level security;
drop policy if exists client_documents_admin on client_documents;
create policy client_documents_admin on client_documents for all
  using (public.is_admin()) with check (public.is_admin());
