-- ╔══════════════════════════════════════════════════════════════════════════╗
-- ║ Horizon Reject gate — per-(client, grant) forecast rejections               ║
-- ╚══════════════════════════════════════════════════════════════════════════╝
-- Shannon reviews the forecasted "On the horizon" shortlist per client and can
-- REJECT a forecast for that client. A reject is permanent for the horizon but must
-- NOT carry through when the grant later flips forecast->posted: at flip the grant's
-- grant_status is nulled, so it drops out of loadForecastCandidates (the ONLY reader
-- of this table) and re-enters the real matched pool (review_cards) fresh. So
-- fresh-look-on-flip needs NO change to the flip handler -- this table is read only on
-- the forecasted render path, NEVER as a review_cards decision. A flipped grant's
-- leftover reject row simply goes inert (never queried again for it).
--
-- Identity: keyed on (client_id, grant_id). grant_id (the grants UUID) is stable
-- across the flip and same-URL re-ingest (the row is UPDATED in place, not recreated),
-- so a reject survives both. `fon` (opportunity_number) is stamped as a durable
-- forensic backstop for the rare row-churn case (row deleted + recreated under a new
-- UUID); it is NOT consulted by the filter today -- grant_id is.
--
-- Reversible: one-way with an admin Undo (DELETE /api/clients/[id]/forecast-reject),
-- mirroring the reversible grants.prospecting_closed_at pattern. Additive,
-- backfill-safe. Touches none of ingest / queue / pipeline.

begin;

create table if not exists forecast_rejections (
  id           uuid primary key default uuid_generate_v4(),
  client_id    uuid not null references clients(id) on delete cascade,
  grant_id     uuid not null references grants(id) on delete cascade,
  -- Stable opportunity id (opportunity_number) captured at reject time -- forensic
  -- backstop only; the render filter matches on grant_id. Nullable (manual-paste).
  fon          text,
  reason       text,
  rejected_by  uuid references profiles(id) on delete set null,
  rejected_at  timestamptz not null default now(),
  -- One reject per (client, grant); makes the POST idempotent (upsert-ignore).
  unique (client_id, grant_id)
);

-- The render filter (loadForecastCandidates) reads all rejects for one client.
create index if not exists forecast_rejections_client_idx on forecast_rejections (client_id);

alter table forecast_rejections enable row level security;

-- Staff-only, mirroring review_cards (0001): any authenticated user reads/writes. A
-- reject is a 'pass'-class decision, not the admin-gated 'approved' -- no extra guard.
drop policy if exists forecast_rejections_select on forecast_rejections;
create policy forecast_rejections_select on forecast_rejections for select
  using (auth.uid() is not null);

drop policy if exists forecast_rejections_write on forecast_rejections;
create policy forecast_rejections_write on forecast_rejections for all
  using (auth.uid() is not null) with check (auth.uid() is not null);

insert into schema_migrations (version) values ('0053_forecast_rejections') on conflict do nothing;

commit;
