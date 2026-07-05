-- ╔══════════════════════════════════════════════════════════════════════════╗
-- ║ P5 chunk 1 — Stripe payments: invoice link fields + webhook idempotency      ║
-- ╚══════════════════════════════════════════════════════════════════════════╝
-- Admin issues a Stripe invoice for a signed contract; the client pays on Stripe's
-- hosted page; a webhook marks our invoice paid, which lights the invoice_paid
-- derived stage. Card data never touches us (Stripe-hosted, SAQ-A) -- we store
-- only Stripe ids + status.
--
-- The invoices table already exists (0001, admin-only RLS "financial firewall")
-- with amount_cents / status (draft|sent|paid|void) / stripe_invoice_id /
-- paid_date. This migration adds the Stripe link fields + a webhook idempotency
-- ledger.

-- clients: reusable Stripe customer id (one per client, across invoices).
alter table clients add column if not exists stripe_customer_id text;

-- invoices: link to the billed contract, the hosted payment page, currency, creator.
alter table invoices add column if not exists contract_id        uuid references contracts(id) on delete set null;
alter table invoices add column if not exists hosted_invoice_url text;
alter table invoices add column if not exists currency           text not null default 'usd';
alter table invoices add column if not exists created_by         uuid references profiles(id) on delete set null;

-- One invoices row per Stripe invoice (dedupe; also lets the webhook match reliably).
create unique index if not exists invoices_stripe_invoice_id_key
  on invoices (stripe_invoice_id) where stripe_invoice_id is not null;

-- stripe_events: webhook idempotency ledger. The webhook records each processed
-- Stripe event id here so a redelivery is a no-op. Written only by the service
-- role in the webhook; RLS is ON with NO policy => nothing but the service role
-- can read/write it (same posture as the private contracts bucket).
create table if not exists stripe_events (
  id          text primary key,     -- Stripe event id (evt_...)
  type        text,
  created_at  timestamptz not null default now()
);
alter table stripe_events enable row level security;
