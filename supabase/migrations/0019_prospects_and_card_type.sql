-- ╔══════════════════════════════════════════════════════════════════════════╗
-- ║ Track 2 prerequisite — prospects table + review_cards discriminator          ║
-- ╚══════════════════════════════════════════════════════════════════════════╝
-- Prospect cards (non-client orgs the prospect engine surfaces) will share the
-- review_cards table with client cards. They MUST be distinguishable so they
-- never pollute the client-first gate's lock/release computation, which counts
-- only client matches.
--
-- prospects: discovered non-client orgs. source_url is NOT NULL on purpose --
-- the structural hallucination guard. A prospect with no real fetched source URL
-- cannot be written to the table at all; "no source = rejected" is enforced by
-- Postgres, not by a prompt or app check. A fabricated org we might later
-- contact is an externally-visible reputational risk, so the gate is in the
-- schema where it cannot be bypassed.
create table if not exists prospects (
  id                 uuid primary key default uuid_generate_v4(),
  name               text not null,
  org_type           text,
  location_state     text,
  location_county    text,
  source_url         text not null,   -- HARD GUARD: no source URL -> cannot exist
  capability_summary text,            -- inferred from the source; carries a "verify" caveat downstream
  created_at         timestamptz not null default now()
);

alter table prospects enable row level security;
drop policy if exists prospects_select on prospects;
create policy prospects_select on prospects for select
  using (auth.uid() is not null);

-- card_type: the explicit discriminator. Default 'client' so every existing row
-- backfills correctly and current behavior is unchanged. Prospect cards set
-- 'prospect' explicitly. Plain text validated in app code (like decision /
-- hold_category) -- no CHECK, so the vocabulary can evolve without a migration.
alter table review_cards add column if not exists card_type text not null default 'client';

-- prospect_id: set on prospect cards, null on client cards. ON DELETE CASCADE so
-- removing a prospect removes its cards.
alter table review_cards add column if not exists prospect_id uuid references prospects(id) on delete cascade;

-- One card per (grant, prospect). Partial so it does not collide with the
-- existing (grant_id, client_id) uniqueness on client cards (where prospect_id
-- is null). Run only after no duplicate (grant_id, prospect_id) pairs exist --
-- trivially true today since no prospect cards exist yet.
create unique index if not exists review_cards_grant_prospect_uniq
  on review_cards (grant_id, prospect_id)
  where prospect_id is not null;
