-- ╔══════════════════════════════════════════════════════════════════════════╗
-- ║ match_feedback: client_id index for the calibration consumer               ║
-- ╚══════════════════════════════════════════════════════════════════════════╝
--
-- The match-feedback calibration consumer (MATCH_CALIBRATION_ENABLED) reads a
-- client's feedback AT SCORE TIME with `where client_id = <client>` -- a
-- per-client lookup on the scoring hot path. The only index today is 0013's
-- (grant_id, client_id), whose LEADING column is grant_id, so it does not serve a
-- client_id-first probe. At the current corpus (single-digit rows) this is moot,
-- but the index is cheap now and mandatory before the corpus grows, so it lands
-- migration-first, ahead of the consumer code that depends on it.
--
-- Non-concurrent create is fine: match_feedback is tiny, so the brief table lock
-- is nil and the statement stays inside the transaction wrapper + ledger insert.
-- (When this table is large, a concurrent build would have to drop the wrapper;
-- it is not, so it does not.)

begin;

create index if not exists match_feedback_client_idx on match_feedback (client_id);

insert into schema_migrations (version) values ('0083_match_feedback_client_idx') on conflict do nothing;

commit;
