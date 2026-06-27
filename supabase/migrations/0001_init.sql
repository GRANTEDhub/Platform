-- ╔══════════════════════════════════════════════════════════════════════════╗
-- ║ GRANTED Platform — initial schema                                          ║
-- ║ Foundation: roles, profiles, clients, time, invoices, grant-intel tables.  ║
-- ║ Access control is enforced with Postgres RLS, not just the UI.             ║
-- ╚══════════════════════════════════════════════════════════════════════════╝

create extension if not exists "uuid-ossp";

-- ─── roles ───────────────────────────────────────────────────────────────────
-- admin       = firm owners / staff: full access.
-- contractor  = contractors / interns: grant matching only, NO financial data.
do $$ begin
  create type user_role as enum ('admin', 'contractor');
exception when duplicate_object then null;
end $$;

-- ─── profiles ──────────────────────────────────────────────────────────────
-- One row per auth user. role defaults to least-privilege (contractor); an
-- admin promotes trusted users.
create table if not exists profiles (
  id          uuid primary key references auth.users(id) on delete cascade,
  email       text,
  full_name   text,
  role        user_role not null default 'contractor',
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

-- SECURITY DEFINER so it bypasses RLS on profiles → no policy recursion.
create or replace function public.is_admin()
returns boolean
language sql stable security definer set search_path = public
as $$
  select exists (
    select 1 from public.profiles where id = auth.uid() and role = 'admin'
  );
$$;

-- Auto-create a profile when a new auth user signs up.
create or replace function public.handle_new_user()
returns trigger
language plpgsql security definer set search_path = public
as $$
begin
  insert into public.profiles (id, email, full_name)
  values (new.id, new.email, new.raw_user_meta_data->>'full_name')
  on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- Stop non-admins from escalating their own role.
create or replace function public.guard_role_change()
returns trigger
language plpgsql security definer set search_path = public
as $$
begin
  if new.role is distinct from old.role and not public.is_admin() then
    raise exception 'Only admins can change a user role';
  end if;
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists profiles_guard_role on profiles;
create trigger profiles_guard_role
  before update on profiles
  for each row execute function public.guard_role_change();

-- ─── clients ───────────────────────────────────────────────────────────────
-- Operational client roster. Financial figures live in invoices/time_entries,
-- NOT here, so contractors can read the roster (needed for matching) without
-- seeing money.
create table if not exists clients (
  id                  uuid primary key default uuid_generate_v4(),
  name                text not null,
  org_type            text,                          -- nonprofit | local_government | small_business | ...
  status              text not null default 'active',-- active | prospect | paused | closed
  engagement_tier     text,
  primary_contact_name  text,
  primary_contact_email text,
  primary_contact_phone text,
  location_city       text,
  location_county     text,
  location_state      text default 'AR',
  service_area        text[],
  retainer_hours      numeric(8,2) default 0,        -- purchased credit-hours
  contract_start      date,
  contract_end        date,
  next_step           text,                          -- "what's next" for the dashboard
  notes               text,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);

-- ─── time_entries ──────────────────────────────────────────────────────────
create table if not exists time_entries (
  id           uuid primary key default uuid_generate_v4(),
  client_id    uuid not null references clients(id) on delete cascade,
  user_id      uuid references profiles(id) on delete set null,
  work_date    date not null default current_date,
  hours        numeric(6,2) not null check (hours > 0),
  description  text,
  billable     boolean not null default true,
  created_at   timestamptz not null default now()
);

-- ─── invoices ──────────────────────────────────────────────────────────────
create table if not exists invoices (
  id                 uuid primary key default uuid_generate_v4(),
  client_id          uuid not null references clients(id) on delete cascade,
  amount_cents       integer not null default 0,
  status             text not null default 'draft',  -- draft | sent | paid | void
  issued_date        date,
  due_date           date,
  paid_date          date,
  stripe_invoice_id  text,
  notes              text,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);

-- ─── grants (grant-intelligence) ─────────────────────────────────────────────
-- Domestic-only by policy; international programs are filtered at ingest.
create table if not exists grants (
  id                     uuid primary key default uuid_generate_v4(),
  source_url             text,
  funder                 text,
  fon                    text,                       -- funding opportunity number
  title                  text,
  description            text,
  total_funding          text,
  award_min              integer,                    -- cents; treat as ESTIMATE
  award_max              integer,                    -- cents; treat as ESTIMATE
  num_awards             text,
  deadline               date,
  cost_share             text,                       -- match requirement
  eligible_entity_types  text[],
  geographic_eligibility text,
  ineligible_entities    text,
  focus_areas            text[],
  raw_text               text,
  status                 text not null default 'processing', -- processing | ready | archived
  ingested_at            timestamptz not null default now()
);

-- ─── review_cards (match queue) ──────────────────────────────────────────────
-- Prime vs partner eligibility is kept distinct and never conflated.
create table if not exists review_cards (
  id                 uuid primary key default uuid_generate_v4(),
  grant_id           uuid references grants(id) on delete cascade,
  client_id          uuid references clients(id) on delete cascade,
  fit_score          int check (fit_score between 1 and 3),
  proposed_role      text,        -- 'prime' | 'partner'
  recommended_prime  text,        -- when partner-only, who should be prime
  why_fits           text[],
  dealbreakers       text[],
  synopsis           text,
  decision           text not null default 'pending', -- pending | working | approved | passed
  decided_by         uuid references profiles(id) on delete set null,
  created_at         timestamptz not null default now(),
  decided_at         timestamptz
);

create index if not exists review_cards_grant_idx    on review_cards(grant_id);
create index if not exists review_cards_client_idx   on review_cards(client_id);
create index if not exists review_cards_decision_idx on review_cards(decision);
create index if not exists time_entries_client_idx   on time_entries(client_id);
create index if not exists invoices_client_idx       on invoices(client_id);

-- updated_at touch trigger for clients & invoices
create or replace function public.touch_updated_at()
returns trigger language plpgsql as $$
begin new.updated_at := now(); return new; end; $$;

drop trigger if exists clients_touch on clients;
create trigger clients_touch before update on clients
  for each row execute function public.touch_updated_at();

drop trigger if exists invoices_touch on invoices;
create trigger invoices_touch before update on invoices
  for each row execute function public.touch_updated_at();

-- ╔══════════════════════════════════════════════════════════════════════════╗
-- ║ Row Level Security                                                         ║
-- ╚══════════════════════════════════════════════════════════════════════════╝
alter table profiles     enable row level security;
alter table clients      enable row level security;
alter table time_entries enable row level security;
alter table invoices     enable row level security;
alter table grants       enable row level security;
alter table review_cards enable row level security;

-- profiles: see your own (admins see all); update your own; admins manage all.
drop policy if exists profiles_select on profiles;
create policy profiles_select on profiles for select
  using (id = auth.uid() or public.is_admin());

drop policy if exists profiles_update on profiles;
create policy profiles_update on profiles for update
  using (id = auth.uid() or public.is_admin());

drop policy if exists profiles_insert_admin on profiles;
create policy profiles_insert_admin on profiles for insert
  with check (public.is_admin());

-- clients: any authenticated user can READ the roster (needed for matching);
-- only admins can create/edit/delete.
drop policy if exists clients_select on clients;
create policy clients_select on clients for select
  using (auth.uid() is not null);

drop policy if exists clients_write on clients;
create policy clients_write on clients for all
  using (public.is_admin()) with check (public.is_admin());

-- time_entries & invoices: ADMIN ONLY. This is the financial firewall —
-- contractors cannot read or write money, enforced at the database.
drop policy if exists time_admin on time_entries;
create policy time_admin on time_entries for all
  using (public.is_admin()) with check (public.is_admin());

drop policy if exists invoices_admin on invoices;
create policy invoices_admin on invoices for all
  using (public.is_admin()) with check (public.is_admin());

-- grants: any authenticated user can read & ingest; only admins delete.
drop policy if exists grants_select on grants;
create policy grants_select on grants for select
  using (auth.uid() is not null);

drop policy if exists grants_insert on grants;
create policy grants_insert on grants for insert
  with check (auth.uid() is not null);

drop policy if exists grants_update on grants;
create policy grants_update on grants for update
  using (auth.uid() is not null);

drop policy if exists grants_delete on grants;
create policy grants_delete on grants for delete
  using (public.is_admin());

-- review_cards: any authenticated user can read/create/work matches.
-- (Final approval-to-client is gated in app logic for now; tighten in the
--  grant-intelligence phase with a column-level check.)
drop policy if exists review_select on review_cards;
create policy review_select on review_cards for select
  using (auth.uid() is not null);

drop policy if exists review_write on review_cards;
create policy review_write on review_cards for all
  using (auth.uid() is not null) with check (auth.uid() is not null);

-- ─── dashboard view ──────────────────────────────────────────────────────────
-- Per-client roll-up for the CRM dashboard. security_invoker = on so RLS still
-- applies as the querying user (the page itself is admin-gated).
create or replace view client_overview
with (security_invoker = on) as
select
  c.id,
  c.name,
  c.org_type,
  c.status,
  c.engagement_tier,
  c.contract_end,
  c.next_step,
  c.retainer_hours,
  coalesce((select sum(t.hours) from time_entries t
            where t.client_id = c.id and t.billable), 0)            as hours_logged,
  c.retainer_hours
    - coalesce((select sum(t.hours) from time_entries t
                where t.client_id = c.id and t.billable), 0)        as hours_remaining,
  coalesce((select sum(i.amount_cents) from invoices i
            where i.client_id = c.id and i.status = 'sent'), 0)     as owed_cents,
  (select min(g.deadline) from review_cards r
     join grants g on g.id = r.grant_id
    where r.client_id = c.id and r.decision = 'approved'
      and g.deadline >= current_date)                              as next_deadline
from clients c;
