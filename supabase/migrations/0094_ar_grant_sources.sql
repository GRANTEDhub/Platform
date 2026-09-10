-- AR state/regional grant scraper — source registry + per-hit staging + a provenance link on grants.
--
-- Separate, additive monitor for Arkansas state-agency / regional funding that never touches
-- grants.gov. ar_grant_sources holds the watched sources (definitions synced from code, runtime
-- change-detection state stored here); ar_source_items stages every detected hit (grant-type
-- opportunities are promoted into `grants`; loans + PDFs are recorded but never promoted);
-- grants.ar_source_item_id back-references the producing hit (null for grants.gov rows).
--
-- Staff-only: SELECT is is_staff() with NO write policy, so every write runs service-role (the cron /
-- admin route) and no client member can read these tables. Idempotent (if not exists / on conflict),
-- so it is a no-op on the environment where it was already applied.

begin;

create table if not exists ar_grant_sources (
  id uuid primary key default gen_random_uuid(),
  url text not null,
  agency text not null,
  cluster text,
  geo_tag text,
  elig_tag text,
  funding_type text not null default 'grant',
  fetch_mode text not null default 'html',
  rss_url text,
  last_hash text,
  last_checked timestamptz,
  last_changed timestamptz,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table ar_grant_sources enable row level security;
drop policy if exists ar_grant_sources_staff_select on ar_grant_sources;
create policy ar_grant_sources_staff_select on ar_grant_sources
  for select using (public.is_staff());

create table if not exists ar_source_items (
  id uuid primary key default gen_random_uuid(),
  source_id uuid not null references ar_grant_sources(id) on delete cascade,
  external_ref text not null,
  doc_type text not null,
  title text,
  detail_url text,
  funding_type text,
  geo_tag text,
  elig_tag text,
  item_hash text,
  status text not null default 'new',
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  changed_at timestamptz
);

alter table ar_source_items enable row level security;
drop policy if exists ar_source_items_staff_select on ar_source_items;
create policy ar_source_items_staff_select on ar_source_items
  for select using (public.is_staff());

create unique index if not exists ar_source_items_external_ref_uniq on ar_source_items (external_ref);
create index if not exists ar_source_items_source_status_idx on ar_source_items (source_id, status);

alter table grants
  add column if not exists ar_source_item_id uuid references ar_source_items(id) on delete set null;

insert into schema_migrations (version) values ('0094_ar_grant_sources') on conflict do nothing;

commit;
