-- ╔══════════════════════════════════════════════════════════════════════════╗
-- ║ One review card per (grant, client)                                         ║
-- ╚══════════════════════════════════════════════════════════════════════════╝
-- Re-running matching stacked duplicate cards (no uniqueness existed). Collapse
-- to one card per (grant, client) -- keeping the most recent -- then enforce it,
-- so the pipeline's insert-or-refresh keeps a single current card instead of
-- piling up. match_attempts is untouched: it remains the full-history log.
--
-- NOTE: this keep-most-recent collapse assumes no human decision has been made
-- on the duplicates yet (true during calibration -- all cards are 'pending').
-- Run before deploying the matching change that relies on the constraint.
delete from review_cards a
  using review_cards b
 where a.grant_id  = b.grant_id
   and a.client_id = b.client_id
   and (a.created_at < b.created_at
        or (a.created_at = b.created_at and a.id < b.id));

alter table review_cards
  add constraint review_cards_grant_client_uniq unique (grant_id, client_id);
