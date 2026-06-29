-- ╔═══════════════════════════════════════════════════════════════════════════╗
-- ║ Review-card decision capture: edited email, reject reason, send tracking   ║
-- ╚═══════════════════════════════════════════════════════════════════════════╝
-- The three-way decision on a match (approve & send as-is / edit & send /
-- reject with reason) needs places to write that the status flag alone cannot:
--
--   final_outreach_email -- the human-approved body that will be sent. Kept
--     separate from draft_outreach_email so the AI's original draft is never
--     overwritten. The gap between what the engine drafted and what actually
--     gets sent is one of the sharpest calibration signals we have.
--   decision_reason      -- why a match was rejected (Pass). Distinct from
--     hold_reason, which stays scoped to Hold.
--   sent_at / sent_to    -- send tracking. NOTE: actual email sending is NOT
--     wired yet (the app has no mail provider). These columns are added now so
--     we don't have to backfill when the send step is built. See the TODO in
--     app/api/review/[id]/route.ts.
alter table review_cards add column if not exists final_outreach_email text;
alter table review_cards add column if not exists decision_reason      text;
alter table review_cards add column if not exists sent_at              timestamptz;
alter table review_cards add column if not exists sent_to              text;
