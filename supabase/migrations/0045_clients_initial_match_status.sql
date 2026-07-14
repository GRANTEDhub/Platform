-- Per-client one-time-match progress + idempotency signal. A prospect added via
-- the client form fires ONE background match against the current grant pool
-- (runInitialMatchForClient); this column tracks that run so the client dashboard
-- can show "matching in progress", and so the run never double-fires.
--   null       -> never run (the trigger fires ONLY when this is null)
--   'running'  -> the one-time match is in flight (dashboard shows the banner)
--   'complete' -> finished (dashboard shows the cards)
--   'error'    -> the run failed (retryable)
-- Only prospects trigger it today; active clients are covered by the daily batch.

begin;

alter table clients
  add column if not exists initial_match_status text;

insert into schema_migrations (version) values ('0045_clients_initial_match_status') on conflict do nothing;

commit;
