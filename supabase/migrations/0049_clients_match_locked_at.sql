-- Concurrency lease for the client one-time-match drain (drainClientMatchQueue).
--
-- Problem: a client-driven continuation loop can run for minutes and WILL overlap
-- the every-10-min client-match cron (and a second browser tab), and both would
-- pick the same 'running' record and re-score its not-yet-attempted grants
-- concurrently -- double the paid LLM calls. There was no way to tell "a drain is
-- actively working this record" apart from "a drain died and left it 'running'".
--
-- Fix: a lease. A drain CLAIMS a client by atomically setting match_locked_at=now()
-- (only when the lease is null or already expired), RENEWS it every ~25s while
-- scoring, and CLEARS it on a clean budget-stop or terminal state. Any other drain
-- skips a client whose lease is still fresh, so two drains never score the same
-- client's pool at once. A dead drain's lease simply expires (~90s), so the record
-- stays claimable and recoverable -- no permanent stuck-'running'.
--   null      -> unclaimed / released (a fresh 'queued' record, or a clean stop).
--   <recent>  -> a drain owns this record right now; others must skip it.
--   <expired> -> the owning drain died; the next drain may reclaim it.
-- The lease is at the CLIENT-CLAIM level only -- scoreGrantClientPair / occupancy
-- are untouched.

begin;

alter table clients
  add column if not exists match_locked_at timestamptz;

insert into schema_migrations (version) values ('0049_clients_match_locked_at') on conflict do nothing;

commit;
