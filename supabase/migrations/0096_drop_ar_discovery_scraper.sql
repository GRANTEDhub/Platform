-- 0096_drop_ar_discovery_scraper — remove the dead page-centric discovery scraper's schema.
--
-- The original AR discovery scraper (#529/#530/#531) is replaced by the platform-owned AR state
-- repository (#532, `grant_monitor_state`). Its code is deleted in the same PR; this migration drops
-- the two tables it staged into — `ar_grant_sources` + `ar_source_items` — plus the
-- `grants.ar_source_item_id` back-reference column 0094 added. Nothing live reads any of them (the live
-- repository uses `grant_monitor_state`, which FKs `grants`, not these tables). The tables are EMPTY
-- (the discovery cron never ran in prod), so this is a no-data-loss drop.
--
-- Order matters: drop the `grants` column FIRST (it FKs `ar_source_items`), then `ar_source_items` (it
-- FKs `ar_grant_sources`), then `ar_grant_sources`. Idempotent (`if exists`) — a no-op if already
-- applied. RLS policies + indexes drop automatically with their tables.

begin;

alter table grants drop column if exists ar_source_item_id;

drop table if exists ar_source_items;
drop table if exists ar_grant_sources;

insert into schema_migrations (version) values ('0096_drop_ar_discovery_scraper') on conflict do nothing;

commit;
