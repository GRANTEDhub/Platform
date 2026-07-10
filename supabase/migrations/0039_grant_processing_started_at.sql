-- ╔══════════════════════════════════════════════════════════════════════════╗
-- ║ Watchdog false-positive fix: measure "stuck" from the current run's start   ║
-- ╚══════════════════════════════════════════════════════════════════════════╝
-- The stuck-pipeline watchdog measured "stuck" from ingested_at (set once, often
-- days old). A re-match/re-shred puts an already-ingested grant into 'processing',
-- so a watchdog tick during that run wrongly flipped it to 'error' -- a false
-- positive ("failed in 5 seconds" while the identical re-match succeeded over
-- ~5 min when no tick collided).
--
-- Fix: track when the CURRENT processing run started, and have the watchdog
-- measure now() - processing_started_at. default now() auto-stamps every INSERT
-- that lands in 'processing'; the re-processing UPDATE paths (re-match, re-ingest,
-- backfill re-shred, forecast re-activation) stamp it explicitly. The watchdog
-- keeps its 15-min threshold and its flip-to-'error' safety behavior -- only the
-- anchor changes.

alter table grants add column if not exists processing_started_at timestamptz default now();

-- Give any row that is in-flight at deploy a fresh window so the watchdog can't
-- flip it prematurely right after this ships. Rows not in 'processing' keep the
-- default; the watchdog only reads this column for status='processing' rows.
update grants set processing_started_at = now() where status = 'processing';
