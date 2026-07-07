-- ╔══════════════════════════════════════════════════════════════════════════╗
-- ║ Grant-alert persistence — save-once, reuse for preview AND send              ║
-- ╚══════════════════════════════════════════════════════════════════════════╝
-- Today the grant alert is regenerated (LLM enrich + Chromium render) on every
-- preview and again on send, so the previewed PDF isn't guaranteed identical to
-- the one that goes out (LLM prose varies). This makes the alert a persisted
-- artifact: generate once, save the exact AlertData + rendered PDF, and reuse
-- that saved version for both preview and send -- so what the admin reviewed is
-- byte-for-byte what the client receives, plus we keep a record of what was sent.
--
-- Two additions, mirroring the contracts pattern (migration 0030):
--   1) A PRIVATE 'grant-alerts' storage bucket for the rendered PDF. Private
--      (public=false): access only via the service role (uploads) and short-lived
--      signed URLs / the admin-gated route (downloads). Separate from 'contracts'
--      -- alerts are client deliverables, not legal records.
--   2) grant_alerts -- one row per generated alert. Holds the exact AlertData and
--      raw enrichment used to render, the saved PDF's storage path, the email
--      subject/body, and the send record (sent_at / sent_to). Admin-only RLS;
--      the send path writes via the service role (bypasses RLS).

-- 1) Private storage bucket for rendered alert PDFs.
insert into storage.buckets (id, name, public)
values ('grant-alerts', 'grant-alerts', false)
on conflict (id) do nothing;

-- 2) Persisted alerts.
create table if not exists grant_alerts (
  id             uuid primary key default uuid_generate_v4(),
  card_id        uuid not null references review_cards(id) on delete cascade,
  grant_id       uuid references grants(id) on delete set null,
  client_id      uuid references clients(id) on delete set null,
  status         text not null default 'draft'
                   check (status in ('draft', 'sent')),
  alert_data     jsonb not null,                 -- exact AlertData rendered (preview == sent)
  enrichment     jsonb,                           -- raw LLM enrichment, for audit / regeneration
  storage_bucket text not null default 'grant-alerts',
  storage_path   text not null,                   -- object path within the bucket (never a public URL)
  subject        text,
  email_body     text,                            -- exact text body that accompanies the PDF
  created_by     uuid references profiles(id) on delete set null,
  created_at     timestamptz not null default now(),
  sent_at        timestamptz,
  sent_to        text
);

create index if not exists grant_alerts_card_idx on grant_alerts (card_id);

-- At most one DRAFT per card: preview reuses it; "Regenerate" replaces it; once a
-- draft is sent (status='sent') it's immutable and a later alert starts a fresh
-- draft. Sent rows are unconstrained, so history accumulates.
create unique index if not exists grant_alerts_one_draft_per_card
  on grant_alerts (card_id) where status = 'draft';

-- Admin-only RLS (financial-firewall pattern, same as client_documents). The
-- generate/send paths write via the service role, which bypasses RLS.
alter table grant_alerts enable row level security;
drop policy if exists grant_alerts_admin on grant_alerts;
create policy grant_alerts_admin on grant_alerts for all
  using (public.is_admin()) with check (public.is_admin());
