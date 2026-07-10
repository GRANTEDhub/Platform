-- ╔══════════════════════════════════════════════════════════════════════════╗
-- ║ Manual add-to-client override — audit trail                                 ║
-- ╚══════════════════════════════════════════════════════════════════════════╝
-- "Add to Client" lets a human manually match a grant the engine didn't surface.
-- A hard gate (disqualified / suppressed / grant-level skip_reason / ineligible
-- funder) used to dead-end with a 422; it now becomes a warn-and-confirm override.
-- These columns record who forced a card past a gate, when, and why -- so the team
-- can tell a human-forced match (especially one past a hard eligibility warning)
-- from an engine-surfaced one.
--
-- Semantics:
--   overridden_by / overridden_at -- set on EVERY manual add (forced or not), so a
--     human-added card is distinguishable from an engine-surfaced card. NULL means
--     engine-surfaced (the normal pipeline / re-match path).
--   override_reason -- set ONLY when the add was FORCED past a block. It carries the
--     severity + the specific gate reason (e.g. "hard: for-profit entities
--     ineligible"). NULL on a non-forced manual add. Presence drives the
--     "Manual override" badge and the prepended before_you_approve note.
--
-- All nullable/additive; existing review_cards RLS covers the new columns (no
-- policy change). No backfill -- historical cards stay NULL (engine-surfaced).

alter table review_cards add column if not exists overridden_by  uuid references profiles(id) on delete set null;
alter table review_cards add column if not exists overridden_at  timestamptz;
alter table review_cards add column if not exists override_reason text;
