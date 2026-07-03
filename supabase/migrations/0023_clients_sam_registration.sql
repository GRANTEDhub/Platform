-- ╔══════════════════════════════════════════════════════════════════════════╗
-- ║ SAM.gov registration resolve + confirm (build 1: capture)                    ║
-- ╚══════════════════════════════════════════════════════════════════════════╝
-- Structured SAM.gov Entity Management fields, captured at intake via a
-- human-confirmed resolve flow (never silent auto-bind). Compliance/readiness
-- only -- NOT read by the matching engine (the matcher keeps using the free-text
-- sam_uei_status from migration 0002). Build 2 will derive an "expiring within
-- 30 days" dashboard flag from sam_expiration_date + sam_checked_at.
--
-- All nullable, additive, backfill-safe. Null across the board = never resolved
-- (the starting state for the whole roster, and the resting state for orgs that
-- are genuinely not SAM-registered -- build 1 makes no positive assertion from a
-- negative; a "not registered" state is revisited in build 2).
--
--   uei                     -- the 12-char UEI; the stable lookup key once bound
--   sam_matched_name        -- the SAM legal business name the human confirmed
--   sam_registration_status -- whatever SAM returns (Active / Expired / Submitted)
--   sam_expiration_date     -- structured; drives build 2's expiration warning
--   sam_checked_at          -- when we last resolved (staleness / refresh model)
alter table clients add column if not exists uei                     text;
alter table clients add column if not exists sam_matched_name        text;
alter table clients add column if not exists sam_registration_status text;
alter table clients add column if not exists sam_expiration_date      date;
alter table clients add column if not exists sam_checked_at           timestamptz;
