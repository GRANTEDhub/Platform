-- ╔══════════════════════════════════════════════════════════════════════════╗
-- ║ Fix: 0057's backfill was too broad -- only decided cards should count       ║
-- ╚══════════════════════════════════════════════════════════════════════════╝
-- 0057 backfilled interested_at on EVERY existing review_cards row, including
-- ones still sitting at decision='pending' -- using created_at as a fallback
-- timestamp since nobody had ever actually decided on them. That was wrong: a
-- still-pending card has no evidence anyone has ever looked at it, so backfilling
-- it anyway skipped it past Grant Alerts, artificially pre-promoting it into the
-- Grant Report even though no one had ever swiped on it. (Caught via live testing
-- against UAMS NorthWest -- 5 pending cards were showing in the Grant Report
-- instead of Grant Alerts.)
--
-- A card that's already been decided (approved/passed) is a different story --
-- being decided IS real evidence someone engaged with it, so leaving those
-- backfilled is correct and intentional; only the still-pending ones are wrong.
--
-- Scoped precisely: a genuine swipe-right sets interested_by (who did it); 0057's
-- blanket backfill only ever touched interested_at, leaving interested_by null.
-- So "decision='pending' AND interested_at is not null AND interested_by is
-- null" identifies exactly the rows 0057 incorrectly promoted -- and nothing
-- else. Any card genuinely swiped since 0057 shipped (interested_by IS set) is
-- left untouched.

begin;

alter table review_cards disable trigger review_cards_guard_approval;
update review_cards
set interested_at = null
where decision = 'pending'
  and interested_at is not null
  and interested_by is null;
alter table review_cards enable trigger review_cards_guard_approval;

insert into schema_migrations (version) values ('0058_fix_interest_backfill_scope') on conflict do nothing;
commit;
