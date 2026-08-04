-- A plain-language, GRANT-LEVEL paraphrase of what a program funds, generated once per
-- grant and reused everywhere a human reads about it.
--
-- WHY: the console detail, the portal detail, and the alert PDF hero all showed
-- `grants.description` (the agency's own prose, frequently one clipped line) or, on the
-- PDF, `review_cards.description_short`. description_short is written by the matcher and
-- is CLIENT-SLANTED ("UAMS NorthWest applies as prime to disburse SDS scholarships..."),
-- so on the alert it read as a second concept proposal sitting directly above the real
-- concept box. This column is the one description all three surfaces share: what the
-- funder provides, to whom, for what purpose, through what activities.
--
--   * description_brief: the paraphrase (<= ~250 words). Null = not generated yet;
--     every reader falls back to grants.description, so a null is invisible, never a gap.
--   * description_brief_at: last SUCCESSFUL generation. A failed or unusable generation
--     does NOT advance it, so the grant retries on the next sweep (parity with
--     usaspending_checked_at / nonprofit_finance_checked_at).
--
-- GRANT-LEVEL, NOT CLIENT-LEVEL, and that is load-bearing: one row is read by every
-- client matched to the grant, so the copy must never name an applicant or a fit. The
-- client-specific read stays where it already lives -- concept_synopsis and why_this_org
-- on the card.
--
-- Enrichment only. Never read by the occupancy/seat scorer (parity with
-- usaspending_summary, 0024), so it cannot move a fit score or flip a seat.
--
-- Additive + nullable; no backfill here. The corpus fills in via the
-- /api/cron/grant-briefs sweep.
begin;

alter table grants add column if not exists description_brief text;
alter table grants add column if not exists description_brief_at timestamptz;

-- The sweep's claim query is `description_brief is null` ordered by ingested_at (grants
-- has no created_at -- see 0001_init), and it runs hourly against the whole table.
-- Partial index so it stays an index scan over the shrinking unwritten set rather than a
-- growing seq scan over every grant.
create index if not exists grants_description_brief_pending_idx
  on grants (ingested_at)
  where description_brief is null;

insert into schema_migrations (version) values ('0069_grants_description_brief') on conflict do nothing;
commit;
