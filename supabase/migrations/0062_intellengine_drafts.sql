-- ╔══════════════════════════════════════════════════════════════════════════╗
-- ║ IntellEngine drafts — the self-serve proposal workspace's persistence       ║
-- ╚══════════════════════════════════════════════════════════════════════════╝
-- IntellEngine becomes a hub: a client can have MULTIPLE proposals in flight at
-- once, each either tied to a matched grant (card_id set) or started from scratch
-- (card_id null). This table is that list. `status` is the FURTHEST step reached
-- in the scope -> compliance -> build flow -- structural progress only, NOT AI
-- content (the generation pipeline is a separate, later build). It drives the
-- hub's status labels and the resume target.
--
-- SAFETY PROPERTIES (why this is safe to apply to prod):
--   1. Brand-new table -- no existing row, policy, or trigger is touched, so
--      applying it changes no current behavior. The IntellEngine surface only
--      starts writing here once the client-product-layer code ships.
--   2. Client-writable but fully client-isolated by RLS: a member can only ever
--      see/write their OWN org's drafts (same is_client_member_of gate as 0055);
--      staff see all. There is no cross-client reach.
--   3. No send path, matcher, or grant/review_card column is touched.

begin;

create table if not exists intellengine_drafts (
  id         uuid primary key default uuid_generate_v4(),
  client_id  uuid not null references clients(id) on delete cascade,
  -- The matched grant this proposal develops. Null = started from scratch.
  -- on delete set null: dropping a card keeps the draft (it just becomes a
  -- from-scratch proposal) rather than silently deleting the client's work.
  card_id    uuid references review_cards(id) on delete set null,
  title      text not null,
  -- Furthest step reached. Ordered scope < compliance < build < complete.
  status     text not null default 'scope',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint intellengine_drafts_status_check
    check (status in ('scope', 'compliance', 'build', 'complete'))
);

-- One draft per matched grant, so re-entering IntellEngine on a grant RESUMES its
-- draft instead of spawning duplicates. From-scratch drafts (card_id null) are
-- exempt -- a client may start as many blank proposals as they like.
create unique index if not exists intellengine_drafts_card_uniq
  on intellengine_drafts(card_id) where card_id is not null;
create index if not exists intellengine_drafts_client_idx on intellengine_drafts(client_id);

alter table intellengine_drafts enable row level security;

-- Staff: full access. Client member: full access to their OWN org's drafts only
-- (mirrors the is_client_member_of gate the portal already uses in 0055).
drop policy if exists intellengine_drafts_staff on intellengine_drafts;
create policy intellengine_drafts_staff on intellengine_drafts for all
  using (public.is_staff()) with check (public.is_staff());

drop policy if exists intellengine_drafts_member on intellengine_drafts;
create policy intellengine_drafts_member on intellengine_drafts for all
  using (public.is_client_member_of(client_id))
  with check (public.is_client_member_of(client_id));

-- Keep updated_at honest on every write (drives the hub's "most recent first").
create or replace function public.touch_intellengine_drafts()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;
drop trigger if exists intellengine_drafts_touch on intellengine_drafts;
create trigger intellengine_drafts_touch before update on intellengine_drafts
  for each row execute function public.touch_intellengine_drafts();

insert into schema_migrations (version) values ('0062_intellengine_drafts') on conflict do nothing;
commit;
