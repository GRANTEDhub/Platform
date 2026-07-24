-- ╔══════════════════════════════════════════════════════════════════════════╗
-- ║ Concept proposals — auto-generated internal snapshot, AM-editable            ║
-- ╚══════════════════════════════════════════════════════════════════════════╝
-- The concept proposal is a single, practical "here's how this client would
-- pursue this grant" snapshot, generated for internal account-manager review the
-- moment an AM marks an account-managed client's card sme_interested (0059). It
-- is the in-platform, grounded version of the concept-proposal logic; it is NOT
-- the multi-API IntellEngine proposal developer (separate, later).
--
-- One row per review card (a card is already the canonical UNIQUE (grant_id,
-- client_id) match row, 0010), mirroring the grant_alerts artifact pattern (0035):
-- admin-only RLS, all writes via the service role (generation runs server-side /
-- in a background waitUntil). No storage bucket -- unlike a grant alert there is
-- no rendered PDF; the proposal is structured data rendered and edited in-app.
--
-- Lifecycle: inserted status='generating' when the trigger fires; a background
-- job flips it to 'ready' (proposal_data set) or 'error' (error set). Generate
-- once; a card that already has a proposal is not regenerated automatically, so a
-- manual staff edit is never silently clobbered. edited_at/by are stamped when an
-- account manager edits the generated draft (the editable pane).

begin;

create table if not exists concept_proposals (
  id             uuid primary key default uuid_generate_v4(),
  card_id        uuid not null references review_cards(id) on delete cascade,
  grant_id       uuid references grants(id) on delete set null,
  client_id      uuid references clients(id) on delete set null,
  status         text not null default 'generating'
                   check (status in ('generating', 'ready', 'error')),
  proposal_data  jsonb,                              -- the ConceptProposal; null until 'ready'
  model          text,                               -- model that produced proposal_data
  error          text,                               -- failure detail when status='error'
  generated_at   timestamptz,                        -- when generation last succeeded
  generated_by   uuid references profiles(id) on delete set null,  -- AM who triggered it
  edited_at      timestamptz,                        -- last manual staff edit
  edited_by      uuid references profiles(id) on delete set null,
  created_at     timestamptz not null default now()
);

-- One concept proposal per card. Regenerate overwrites this row in place; it is
-- not a draft/sent lifecycle like grant_alerts.
create unique index if not exists concept_proposals_one_per_card
  on concept_proposals (card_id);

-- Admin-only RLS (same financial-firewall pattern as grant_alerts / client_documents).
-- The generate / edit paths write via the service role, which bypasses RLS.
alter table concept_proposals enable row level security;
drop policy if exists concept_proposals_admin on concept_proposals;
create policy concept_proposals_admin on concept_proposals for all
  using (public.is_admin()) with check (public.is_admin());

insert into schema_migrations (version) values ('0060_concept_proposals') on conflict do nothing;
commit;
