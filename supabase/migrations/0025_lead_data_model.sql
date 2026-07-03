-- ╔══════════════════════════════════════════════════════════════════════════╗
-- ║ Lead data model — leads live on the clients table (stage flag) + grant-hook  ║
-- ╚══════════════════════════════════════════════════════════════════════════╝
-- Continuity by design: a lead is a clients row with pipeline_stage set. On
-- conversion NOTHING moves -- pipeline_stage flips to 'converted' and status to
-- 'active' on the SAME row, so intake, notes, hooks, timeline, and account
-- manager carry forward with zero migration.
--
-- Two-layer stage model:
--   * pipeline_stage (STORED) holds only human-judgment positions + terminal
--     'converted'. Derived positions (discovery_scheduled, contracting,
--     payment_pending, paid) are COMPUTED at read time by lib/leads/stage.ts --
--     never stored. The CHECK enforces that.
--   * status stays the operational flag. status='active' remains the matcher/
--     roster selector; a lead is status <> 'active' (convention 'lead') until
--     conversion. INVARIANT: never give an un-converted lead status='active', or
--     runMatching (service role, bypasses RLS) will score grants against it.

-- ── clients: lead columns (all additive / nullable) ──
alter table clients add column if not exists pipeline_stage     text;
alter table clients add column if not exists lead_source        text;
alter table clients add column if not exists account_manager_id uuid references profiles(id) on delete set null;
alter table clients add column if not exists intake_data        jsonb;
alter table clients add column if not exists needs_review       boolean not null default false;
alter table clients add column if not exists archived_reason    text;
alter table clients add column if not exists contract_status    text;
alter table clients add column if not exists contract_signed_at timestamptz;
alter table clients add column if not exists unsubscribed_at    timestamptz;

-- Stored pipeline_stage = human stages + terminal 'converted' ONLY. Derived
-- stages are never stored (see lib/leads/stage.ts).
do $$ begin
  alter table clients add constraint clients_pipeline_stage_chk
    check (pipeline_stage is null or pipeline_stage in
      ('outbound_new','new','contacted','quoted','pending','archived','converted'));
exception when duplicate_object then null; end $$;

do $$ begin
  alter table clients add constraint clients_lead_source_chk
    check (lead_source is null or lead_source in ('inbound','grant_match','outbound'));
exception when duplicate_object then null; end $$;

create index if not exists clients_pipeline_stage_idx
  on clients (pipeline_stage) where pipeline_stage is not null;
create index if not exists clients_account_manager_idx
  on clients (account_manager_id);

-- ── lead_grant_hooks: the grant-match context that grounds warm outreach ──
-- One row per (lead, grant): the scored fit snapshotted durably (prospect rows
-- are non-durable -- 0022). A lead accrues many hooks as new grants fit over time.
create table if not exists lead_grant_hooks (
  id                uuid primary key default uuid_generate_v4(),
  client_id         uuid not null references clients(id) on delete cascade,
  grant_id          uuid references grants(id) on delete set null,
  prospect_id       uuid references prospects(id) on delete set null,    -- provenance; non-durable
  review_card_id    uuid references review_cards(id) on delete set null, -- provenance; non-durable
  fit_score         integer,
  proposed_role     text,
  recommended_prime text,
  why_snapshot      jsonb,   -- snapshot of why_this_org (survives prospect cleanup)
  concept_snapshot  text,    -- snapshot of concept_synopsis
  created_at        timestamptz not null default now(),
  unique (client_id, grant_id)
);
create index if not exists lead_grant_hooks_client_idx on lead_grant_hooks (client_id);
create index if not exists lead_grant_hooks_grant_idx  on lead_grant_hooks (grant_id);

-- ── RLS ──
-- Leads are ADMIN-ONLY. Contractors keep full read of real clients (needed for
-- matching): visible to non-admins only if the row never entered the pipeline
-- (pipeline_stage is null) OR graduated (='converted'). Writes stay admin-only.
-- Public intake (later) inserts via the service role (bypasses RLS) -- no anon
-- policy added.
drop policy if exists clients_select on clients;
create policy clients_select on clients for select
  using (public.is_admin() or pipeline_stage is null or pipeline_stage = 'converted');

alter table lead_grant_hooks enable row level security;
drop policy if exists lead_grant_hooks_admin on lead_grant_hooks;
create policy lead_grant_hooks_admin on lead_grant_hooks for all
  using (public.is_admin()) with check (public.is_admin());

-- pipeline_events: NO schema change. event_type is free text; the lead timeline
-- reuses it with new values ('note','email_sent','email_received','call_logged',
-- 'stage_change','lead_created','booked_call','contract_signed','invoice_paid',
-- 'converted'). Documented here; created in app code.
