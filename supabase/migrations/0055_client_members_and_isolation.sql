-- ╔══════════════════════════════════════════════════════════════════════════╗
-- ║ Client portal foundation — membership ("guest list") + seat limits +        ║
-- ║ role-aware data isolation (the "locks")                                     ║
-- ╚══════════════════════════════════════════════════════════════════════════╝
-- Phase 3, Slice 3a of the client-facing operations hub. This migration adds the
-- ability for CLIENT users (distinct from staff) to log in, and — critically —
-- rewrites the data-access rules so a client can only ever see their OWN org.
--
-- SAFETY PROPERTY (why this is safe to apply to prod today):
--   Every rewritten policy replaces the bare predicate `auth.uid() is not null`
--   with `public.is_staff()`. Today EVERY authenticated user is staff (they have
--   a profiles row), so is_staff() == (auth.uid() is not null) for all current
--   users => ZERO observable change for staff. The new client-member branches
--   affect nobody until a client_members row exists (none do yet), and the
--   handle_new_user guard is a no-op until an invited email exists. So applying
--   this changes the RULES, not the behavior — isolation switches on only once a
--   client is actually invited (Slice 3c).
--
-- Locks-before-doors: this ships BEFORE any portal login path (Slice 3b), so the
-- instant a client can authenticate, isolation is already fully enforced.

begin;

-- ── Multi-seat: how many portal members a client org may have (default 1; staff
--    raise it per the pricing tier -- the design partner gets 5, set by hand). ──
alter table clients add column if not exists seat_limit integer not null default 1;

-- ── client_members: the "guest list" — which email belongs to which client org.
--    A client PORTAL user, NOT staff (staff live in profiles). user_id is null
--    until the invited email first logs in and is auto-linked (see handle_new_user
--    below). Email stored lowercase so the unique index + lookups are consistent. ──
create table if not exists client_members (
  id           uuid primary key default uuid_generate_v4(),
  client_id    uuid not null references clients(id) on delete cascade,
  email        text not null,
  user_id      uuid references auth.users(id) on delete set null,
  role         text not null default 'member',   -- 'primary' | 'member' (app-validated)
  invited_by   uuid references profiles(id) on delete set null,
  invited_at   timestamptz not null default now(),
  activated_at timestamptz,                       -- set on first successful login
  constraint client_members_email_lower check (email = lower(email))
);
create unique index if not exists client_members_client_email_uniq on client_members (client_id, email);
create index if not exists client_members_user_idx  on client_members (user_id);
create index if not exists client_members_email_idx on client_members (email);

-- ── Helpers (SECURITY DEFINER so they bypass RLS on the tables they read → no
--    policy recursion, same technique as the existing is_admin()). ──

-- is_staff(): does the caller have a staff profile? (admin OR contractor). This is
-- the "see everything" gate that replaces bare auth.uid() checks below.
create or replace function public.is_staff()
returns boolean
language sql stable security definer set search_path = public
as $$ select exists (select 1 from public.profiles where id = auth.uid()) $$;

-- is_client_member_of(): is the caller an ACTIVATED portal member of target_client?
create or replace function public.is_client_member_of(target_client uuid)
returns boolean
language sql stable security definer set search_path = public
as $$
  select exists (
    select 1 from public.client_members
     where client_id = target_client
       and user_id = auth.uid()
       and activated_at is not null
  )
$$;

alter table client_members enable row level security;

-- Staff manage all memberships; a portal member may read only their OWN rows.
drop policy if exists client_members_staff on client_members;
create policy client_members_staff on client_members for all
  using (public.is_staff()) with check (public.is_staff());

drop policy if exists client_members_self_select on client_members;
create policy client_members_self_select on client_members for select
  using (user_id = auth.uid());

-- ── Keep client logins OUT of staff. handle_new_user() currently gives EVERY new
--    auth user a profiles row (role defaults to 'contractor') — so a client magic
--    link would silently become staff. Guard it: an invited client email gets NO
--    staff profile, and is auto-linked to its membership instead. Falls through to
--    the original staff-profile insert for everyone else => no change for staff. ──
create or replace function public.handle_new_user()
returns trigger
language plpgsql security definer set search_path = public
as $$
begin
  if exists (select 1 from public.client_members where email = lower(new.email)) then
    -- Client portal member: link the auth user to their membership, no staff profile.
    update public.client_members
       set user_id = new.id, activated_at = coalesce(activated_at, now())
     where email = lower(new.email);
    return new;
  end if;
  insert into public.profiles (id, email, full_name)
  values (new.id, new.email, new.raw_user_meta_data->>'full_name')
  on conflict (id) do nothing;
  return new;
end;
$$;

-- ════════════════════════════════════════════════════════════════════════════
-- The locks: re-scope every bare `auth.uid() is not null` policy. Staff branch =
-- is_staff() (identical to today for all current users). Portal-exposed tables
-- (clients, review_cards, grants) additionally allow a client member to read
-- their OWN rows. Everything else becomes staff-only (a client session sees
-- nothing there). Client members are READ-ONLY — no write branch anywhere.
-- ════════════════════════════════════════════════════════════════════════════

-- clients: staff keep the lead-visibility logic (0027); a member sees only their org.
drop policy if exists clients_select on clients;
create policy clients_select on clients for select
  using (
    (public.is_staff() and (public.is_admin() or pipeline_stage is null or pipeline_stage = 'converted'))
    or public.is_client_member_of(id)
  );

-- review_cards: staff see all; a member sees only their own client's cards. Writes
-- become staff-only (previously any authenticated user could write).
drop policy if exists review_select on review_cards;
create policy review_select on review_cards for select
  using (public.is_staff() or public.is_client_member_of(client_id));

drop policy if exists review_write on review_cards;
create policy review_write on review_cards for all
  using (public.is_staff()) with check (public.is_staff());

-- grants: staff see all; a member sees only grants they have a card for. (Grants
-- aren't client-owned — a client reaches one only through their own review_cards.)
-- INSERT/UPDATE stay as 0046 set them (admin); only SELECT is re-scoped here.
drop policy if exists grants_select on grants;
create policy grants_select on grants for select
  using (
    public.is_staff()
    or exists (
      select 1 from public.review_cards rc
       where rc.grant_id = grants.id and public.is_client_member_of(rc.client_id)
    )
  );

-- Internal-only surfaces: close the "any authenticated user" hole → staff-only.
drop policy if exists match_attempts_select on match_attempts;
create policy match_attempts_select on match_attempts for select
  using (public.is_staff());

drop policy if exists match_feedback_select on match_feedback;
create policy match_feedback_select on match_feedback for select
  using (public.is_staff());

drop policy if exists match_feedback_insert on match_feedback;
create policy match_feedback_insert on match_feedback for insert
  with check (public.is_staff());

drop policy if exists forecast_rejections_select on forecast_rejections;
create policy forecast_rejections_select on forecast_rejections for select
  using (public.is_staff());

drop policy if exists forecast_rejections_write on forecast_rejections;
create policy forecast_rejections_write on forecast_rejections for all
  using (public.is_staff()) with check (public.is_staff());

insert into schema_migrations (version) values ('0055_client_members_and_isolation') on conflict do nothing;
commit;
