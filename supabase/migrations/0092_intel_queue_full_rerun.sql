-- ╔══════════════════════════════════════════════════════════════════════════╗
-- ║ Merged "Re-run grant match" — mark a queue job as a full re-run (PR 1)      ║
-- ╚══════════════════════════════════════════════════════════════════════════╝
--
-- The console's two IntellEngine buttons ("Re-run grant match" which only ran the QA pass, and
-- "Re-extract uses of funds") collapse into ONE staff action that re-runs the WHOLE review in the
-- background: engine re-match (scoreGrantClientPair — can drop/refresh the card) → QA (runIntelReview)
-- → allowable-uses refresh. It reuses the existing auto-QA queue + drain + watchdog (0087) instead of a
-- second queue, so the only schema change is a marker that tells the drain a job is a full re-run vs the
-- poller's ordinary QA-only enqueue.
--
--   kind = 'auto'       → the poller's QA-only job (0087 behavior, unchanged).
--   kind = 'full_rerun' → a staff-requested full re-run; the drain runs the engine re-match FIRST (on the
--                         job's first attempt only), then the QA pass, then the uses refresh.
--
-- DEFAULT 'auto' is load-bearing: pollAndEnqueue's existing inserts don't set `kind`, so every
-- poller-enqueued job defaults to 'auto' and the auto-QA path is byte-identical to today. Only
-- enqueueFullRerun (behind MERGED_RERUN_ENABLED) ever writes 'full_rerun'. Flag OFF → no full_rerun row
-- is ever created → the drain's re-match branch is dead code → byte-identical to today.

begin;

alter table intel_review_queue
  add column if not exists kind text not null default 'auto';

-- The button's persistent "Running…" state reads (kind, status) for the pair, so it filters on kind;
-- the existing status/enqueued_at index still serves the drain's claim scan.
create index if not exists intel_review_queue_kind_idx on intel_review_queue (kind, status);

insert into schema_migrations (version) values ('0092_intel_queue_full_rerun') on conflict do nothing;
commit;
