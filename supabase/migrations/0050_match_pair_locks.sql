-- Per-pair reservation lock for the client one-time-match drain (drainClientMatchQueue).
--
-- Kills the window-boundary double-score at its root. The drain scores a pool across
-- several time-boxed windows; a pair still in flight when a window ends was abandoned
-- and, because it hadn't committed its match_attempts row yet, RE-SCORED by the next
-- round -- duplicate attempts + a second paid LLM call (~CONCURRENCY per boundary;
-- ~25-36 dup attempts on a 46-grant run). A grace window can't fix it: runtime logs
-- show pairs run ~60-90s under 429 backoff, far past any grace that fits under the
-- ~100s HTTP cap.
--
-- Fix: a worker CLAIMS (client_id, grant_id) here BEFORE its LLM call and RENEWS
-- locked_at every ~25s while scoring. Another worker/round skips a pair whose lock is
-- younger than the TTL, so an in-flight pair can't be re-scored. The TTL is NOT sized
-- to worst-case pair time (the Anthropic SDK has no hard request timeout, so a
-- backed-off pair has no clean upper bound) -- renewal makes that moot: a slow-but-
-- alive pair stays fresh and is never stolen; only a worker that STOPS renewing
-- (frozen/killed) lets its lock go stale and be reclaimed, so the pool always
-- completes. Composite PK gives the atomic claim (insert-if-absent; else take over
-- only a stale lock). A finished pair's lock is NOT deleted per-pair (that would
-- reopen the dup race); rows are swept when the client completes, so the table stays
-- small (<= pool size per in-flight client).
--
-- Written only by the drain via the service client (which bypasses RLS). RLS is ON
-- with NO policies, so it is inaccessible to anon/authenticated roles -- an internal
-- coordination table, never read by the app UI.

begin;

create table if not exists match_pair_locks (
  client_id  uuid not null references clients(id) on delete cascade,
  grant_id   uuid not null references grants(id) on delete cascade,
  locked_at  timestamptz not null default now(),
  primary key (client_id, grant_id)
);

-- Reclaim probe (claimPair) filters on locked_at; index it for the stale-lock lookup.
create index if not exists match_pair_locks_locked_at_idx on match_pair_locks (locked_at);

alter table match_pair_locks enable row level security;

insert into schema_migrations (version) values ('0050_match_pair_locks') on conflict do nothing;

commit;
