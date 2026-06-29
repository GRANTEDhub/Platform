-- ╔══════════════════════════════════════════════════════════════════════════╗
-- ║ Shred-depth marker — full NOFO vs API summary                               ║
-- ╚══════════════════════════════════════════════════════════════════════════╝
-- Step 2 deepens the shred by fetching + parsing the real program NOFO. When it
-- succeeds, the grant carries the full analytical depth (scoring rubric,
-- delivery/convener model); when no real NOFO validates, it falls back to the
-- thin API summary -- and we must KNOW which, so a thin score isn't mistaken for
-- a fully-informed one. shred_reason records why (e.g. "only generic guides
-- attached; additional_info_url did not yield a NOFO").
alter table grants add column if not exists shred_depth  text default 'summary';
alter table grants add column if not exists shred_reason text;
