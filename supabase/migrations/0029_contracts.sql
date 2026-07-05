-- ╔══════════════════════════════════════════════════════════════════════════╗
-- ║ P4 chunk 1 — native e-sign: contracts (signing flow; PDF is chunk 2)         ║
-- ╚══════════════════════════════════════════════════════════════════════════╝
-- A contract is a legal/financial record: admin-only RLS (mirrors invoices /
-- time_entries -- the financial firewall). The PUBLIC signing action writes via
-- the service role (bypasses RLS), gated by possession of a valid tokenized link
-- (access_tokens, action_type='lead_sign_contract'), NOT by RLS.
--
-- body_snapshot stores the EXACT text the signer agreed to, captured at creation,
-- so the record is immutable even if the template changes later. token_id binds
-- the signing link to this specific contract (a lead can have multiple over time;
-- regenerating a link voids the prior contract, invalidating its old link).
-- pdf_url stays null this chunk -- chunk 2 renders + stores the signed PDF.

create table if not exists contracts (
  id                uuid primary key default uuid_generate_v4(),
  client_id         uuid not null references clients(id) on delete cascade,
  token_id          uuid references access_tokens(id) on delete set null, -- the active signing link
  template_key      text not null,                     -- navigate | navigate_plus | flex | custom (validated in app)
  amount_cents      integer,                           -- engagement amount (ESTIMATE/quoted); nullable for custom-TBD
  body_snapshot     text not null,                     -- immutable copy of the terms the signer agreed to
  status            text not null default 'draft',     -- draft | sent | signed | void
  signer_name       text,                              -- typed full name (the electronic signature)
  signer_ip         text,
  signer_user_agent text,
  signed_at         timestamptz,
  pdf_url           text,                              -- chunk 2 fills this
  created_by        uuid references profiles(id) on delete set null,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  constraint contracts_status_chk check (status in ('draft','sent','signed','void'))
);
create index if not exists contracts_client_idx on contracts (client_id);
create index if not exists contracts_token_idx  on contracts (token_id);

-- Touch updated_at on write (reuse the trigger fn from 0001).
drop trigger if exists contracts_touch_updated_at on contracts;
create trigger contracts_touch_updated_at before update on contracts
  for each row execute function public.touch_updated_at();

-- RLS: admin-only for ALL app access. The public /sign write path uses the
-- service role and is gated by the token, not RLS.
alter table contracts enable row level security;
drop policy if exists contracts_admin on contracts;
create policy contracts_admin on contracts for all
  using (public.is_admin()) with check (public.is_admin());
