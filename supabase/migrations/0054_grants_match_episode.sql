-- ╔══════════════════════════════════════════════════════════════════════════╗
-- ║ Move 2 — within-grant roster chunking: the matching-episode marker           ║
-- ╚══════════════════════════════════════════════════════════════════════════╝
-- runMatching no longer must finish the whole roster in one 300s window. It scores
-- within a wall-clock DEADLINE and re-queues whatever doesn't fit for the next drain
-- cycle. Resume is cursor-free -- like the client drain (match-queue.ts), "already
-- scored" is derived from match_attempts (every scoring attempt writes a row).
--
-- This column BOUNDS that attempts-diff to the current episode. Grant matching is
-- re-runnable (a re-match re-scores the whole roster), so without an episode boundary
-- the diff would see every client as already-done and a re-match would score nothing.
-- A fresh episode stamps this marker (runPipeline's re-shred, enqueueMatch, and the
-- rematch route); a chunk re-queue PRESERVES it so resume continues the same episode.
--
-- Nullable / backfill-safe: null = a legacy row (or a manual `status='queued'` SQL
-- enqueue) -- runMatching treats null as a fresh episode and stamps it on entry.
-- Additive; changes NO scoring, seat, occupancy, gate, or rubric behavior.

begin;

alter table grants add column if not exists match_episode_started_at timestamptz;

insert into schema_migrations (version) values ('0054_grants_match_episode') on conflict do nothing;

commit;
