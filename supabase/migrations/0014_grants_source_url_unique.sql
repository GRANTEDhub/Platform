-- ╔══════════════════════════════════════════════════════════════════════════╗
-- ║ One grant row per opportunity URL                                           ║
-- ╚══════════════════════════════════════════════════════════════════════════╝
-- A failure window on 2026-06-27 left 4 orphaned rows for a single opportunity:
-- the manual-ingest source_url reuse did not exist yet, so each retry inserted a
-- fresh row. The reuse exists now, but it is check-then-insert (not atomic), so
-- concurrent ingests of the same URL could still race into duplicates. This
-- partial unique index makes duplicate grant rows for a real URL structurally
-- impossible, across both the manual and cron paths.
--
-- Excludes the "manual-paste" sentinel (raw-text pastes share it and must be
-- allowed to coexist). Run only after de-duplicating any existing rows -- the
-- index build fails if duplicates remain.
create unique index if not exists grants_source_url_uniq
  on grants (source_url)
  where source_url is not null and source_url <> 'manual-paste';
