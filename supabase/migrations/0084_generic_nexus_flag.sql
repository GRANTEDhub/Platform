-- ╔══════════════════════════════════════════════════════════════════════════╗
-- ║ review_cards.generic_nexus_flagged: the generic-over-specific demote key    ║
-- ╚══════════════════════════════════════════════════════════════════════════╝
--
-- Fix #6 (generic-over-specific). The scored-at-2 demote tag needs a persisted
-- secondary sort key so a flagged card sinks to the BOTTOM of its fit-2 tier
-- (demote-within-2, NOT a suppress and NOT a fit 2->1 cap). The card lists sort
-- `fit_score DESC, created_at DESC`; this column slots BETWEEN them as
-- `generic_nexus_flagged ASC` (false first), so an inferred-nexus card is
-- demoted within its score band while a genuine execution-conditional 2 is
-- untouched.
--
-- MIGRATION-FIRST, ahead of the code that references it. Once the PR deploys,
-- scoreGrantClientPair writes this column and the review / grants / intel card
-- lists ORDER BY it -- both would error if the column were absent. `not null
-- default false` makes it backward-compatible: every existing card and every
-- flag-OFF write is `false` (= today's sort position), so applying this ahead of
-- the merge is a no-op on the live surface and safe to sit in prod indefinitely
-- before the flag is flipped.
--
-- The flag itself (MATCH_GENERIC_NEXUS_GATE_ENABLED) is what makes the classifier
-- run and set this true; with it OFF the column stays all-false and the added
-- ORDER BY is inert. Non-concurrent add of a defaulted boolean is a cheap
-- metadata-only change (no table rewrite in modern Postgres), so it stays inside
-- the transaction wrapper + ledger insert.

begin;

alter table review_cards
  add column if not exists generic_nexus_flagged boolean not null default false;

insert into schema_migrations (version) values ('0084_generic_nexus_flag') on conflict do nothing;

commit;
