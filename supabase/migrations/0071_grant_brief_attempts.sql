-- ╔══════════════════════════════════════════════════════════════════════════╗
-- ║ Brief generation attempts — stop the sweep re-failing the same rows forever  ║
-- ╚══════════════════════════════════════════════════════════════════════════╝
-- The hourly brief sweep (0069) claims `description_brief is null` oldest-first and
-- deliberately does NOT advance description_brief_at on failure, so a transient
-- Anthropic error retries next hour. #308 called that "retried on the next run at no
-- risk." It is not free: a row that can NEVER generate is never written and never
-- parked, so it stays in the claim window permanently while successful rows leave it.
-- The window fills with permanent failures.
--
-- Observed in production 2026-08-05, oldest-first over 371 unwritten briefs:
--     00:37  written 25, skipped 0   ( 0%)
--     16:37  written 20, skipped 5   (20%)
--     17:37  written 18, skipped 7   (28%)
--     18:37  written 11, skipped 9   (45% of 20)
-- Monotonic. It plateaus rather than stalling outright -- only 13 of the 371 lack
-- raw_text entirely -- so steady state is ~13 slots of the cap burning an Anthropic
-- call each, every hour, forever. Wasteful, and invisible per-run: every one of those
-- responses is a 200 with a healthy-looking log line. Only the trend shows it.
--
-- WHY A COUNTER AND NOT A CLAIM-SIDE FILTER. Excluding `raw_text is null` would only
-- handle the cause we guessed. With raw_text present, briefSource clears the 120-char
-- floor and generation actually RUNS -- so a skip can equally be model output under the
-- 45-word stub floor, or an API error. A counter is agnostic to cause: N attempts and
-- the row leaves the window whatever the reason. Mirrors grants.match_retry_count,
-- which exists for exactly this problem on the matching side.
--
-- SAFETY PROPERTIES (why this is safe to apply to prod):
--   1. Additive column, NOT NULL DEFAULT 0 -- every existing row reads as "no attempts
--      yet", so the claim set is identical on apply and no behavior changes until the
--      sweep code ships.
--   2. No RLS policy, trigger, or client-writable surface is touched. grants is
--      staff/service-role only; this column is written solely by the sweep.
--   3. The matcher, queue, gate, and ingest path are untouched -- this column is read
--      and written by lib/grants/brief.ts only.
--   4. Reversible with no data loss: dropping the column restores the previous
--      (looping) behavior exactly.

begin;

-- Attempts that ended in NO brief. Reset is deliberate-by-omission: nothing clears this
-- automatically, because a row that failed 3 times is not expected to start working. A
-- recovered grant (e.g. source_url re-pointed to a live opportunity id, which is the
-- documented recovery for the 404 husk family) is re-armed by setting this back to 0.
alter table grants add column if not exists description_brief_attempts integer not null default 0;

-- Replaces 0069's index. The claim query now carries a second predicate
-- (`description_brief_attempts < 3`), so the partial index has to match it or the
-- planner falls back to scanning every unwritten row -- including the parked ones this
-- change exists to stop touching.
--
-- The literal 3 is duplicated here and in MAX_BRIEF_ATTEMPTS (lib/grants/brief.ts). A
-- partial index predicate cannot reference application config, so this is inherent:
-- raising the cap in code means a new migration to widen the index, and the comment in
-- brief.ts says so at the constant.
drop index if exists grants_description_brief_pending_idx;
create index if not exists grants_description_brief_pending_idx
  on grants (ingested_at)
  where description_brief is null and description_brief_attempts < 3;

-- The phase-2 re-do window (a brief written before the raw_text fallback reached prod)
-- is a different claim: `description_brief is not null` ordered by description_brief_at.
-- It had no index at all -- fine while it was starved to zero rows, worth having now
-- that #311 reserves it slots. Partial, so it disappears once the window drains.
create index if not exists grants_description_brief_recut_idx
  on grants (description_brief_at)
  where description_brief is not null;

insert into schema_migrations (version) values ('0071_grant_brief_attempts') on conflict do nothing;
commit;
