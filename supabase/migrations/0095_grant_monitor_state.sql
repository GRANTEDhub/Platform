-- 0095_grant_monitor_state — platform-owned repository of monitored state/regional grant programs.
--
-- Sidecar to `grants`: one row per curated program link the weekly monitor re-scans. Provenance is
-- "has a grant_monitor_state row" (no column added to grants). jurisdiction is the first-class state
-- key ('AR' now; 'MS'/'OK' later = pure data). funder_type + monitor_mode carry the reference/auto and
-- (future) philanthropy split so the model generalizes without a fork. Staff-only SELECT, all writes
-- service-role (the 0094 pattern) — no client member can read it. Idempotent (if not exists), so it is
-- a no-op on the environment where it was already applied.

begin;

create table if not exists grant_monitor_state (
  id                uuid primary key default gen_random_uuid(),
  grant_id          uuid not null references grants(id) on delete cascade,
  jurisdiction      text not null,                    -- 2-letter state key: 'AR'
  funder_type       text not null,                    -- 'state' | 'local' | 'private'
  monitor_mode      text not null default 'auto',     -- 'auto' (scan the page) | 'reference' (no page to diff)
  monitor_url       text,                             -- link the weekly monitor re-fetches (may be shared across rows)
  seed_batch        text,                             -- provenance, e.g. 'ar_master_sheet_2026'
  last_content_hash text,
  last_checked_at   timestamptz,
  last_changed_at   timestamptz,
  created_at        timestamptz not null default now()
);

create unique index if not exists grant_monitor_state_grant_uniq on grant_monitor_state (grant_id);
create index if not exists grant_monitor_state_juris_idx on grant_monitor_state (jurisdiction, funder_type);

alter table grant_monitor_state enable row level security;
drop policy if exists grant_monitor_state_staff_select on grant_monitor_state;
create policy grant_monitor_state_staff_select on grant_monitor_state
  for select using (public.is_staff());

insert into schema_migrations (version) values ('0095_grant_monitor_state') on conflict do nothing;

commit;
