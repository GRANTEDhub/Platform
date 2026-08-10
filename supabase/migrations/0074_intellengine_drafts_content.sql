-- ╔══════════════════════════════════════════════════════════════════════════╗
-- ║ intellengine_drafts.content — the Pursuit flow's first real persistence     ║
-- ╚══════════════════════════════════════════════════════════════════════════╝
-- Step 1 of the build order in docs/pursuit-state-audit-2026-08.md §5. Until now
-- the table held only `title` and `status`, so everything the three Pursuit steps
-- collect -- scope of work, role, budget, partners, notes, and all nine section
-- drafts -- was discarded on navigate. This is the column they will be written to.
--
-- NOTHING WRITES IT YET, deliberately. Wiring the scope and build forms is step 2.
-- This lands the column and the corrected status semantics first so that the code
-- reading progress is honest before anything starts producing progress to read.
--
-- ONE JSONB, NOT FIVE COLUMNS AND A CHILD TABLE. Nothing queries these fields --
-- they are read whole, for one draft, by one page -- and the shape will churn across
-- steps 2-6 (AI provenance, regeneration counts, NOFO-derived per-section
-- instructions). jsonb absorbs that without four more migrations, and it matches the
-- house pattern for exactly this: grants.allowable_uses, clients.intake_data, both
-- read through a tolerant reader that treats anything unrecognised as empty.
--
-- The accepted cost: two teammates editing one draft at the same time clobber at
-- DRAFT granularity rather than per section. At a seat_limit of 2 that is unlikely,
-- and because every read goes through one module (lib/intellengine/content.ts),
-- promoting `sections` to its own table later is a contained change.
--
-- Documented shape (enforced in app code, not by the DB):
--   {
--     scope:    { scope, role: "prime"|"partner", budget,
--                 partners: [{ name, role, description }], notes },
--     sections: [{ id, draft, source: "client"|"ai", updatedAt }]
--   }
--
-- FILES ARE NOT IN IT. Storing filenames here would recreate the exact lie step 3
-- exists to remove -- a file row that looks received when nothing was uploaded.
-- Uploads stay absent until there is a bucket behind them.
--
-- TEMPLATE TEXT IS NEVER STORED IN IT. Templates stay UI placeholders, so
-- "section draft is non-empty" means a human or the model actually wrote it, by
-- construction, rather than being true the moment a draft is created.
--
-- SAFETY PROPERTIES (why this is safe to apply to prod):
--   1. Additive column with a default, on a table holding ONE row, for a feature
--      gated off clients entirely (PURSUIT_CLIENT_ACCESS_ENABLED). No policy,
--      trigger, index, matcher, or send path is touched.
--      `add column if not exists` -- idempotent, safe to re-run.
--   2. No RLS change needed. 0062's policies are `for all` on the table (staff, and
--      is_client_member_of for a member), so a new column is already covered by
--      both. There is no way for this to widen access.
--   3. No backfill. '{}' reads as "nothing captured", which is true of every
--      existing row -- none of them ever had anywhere to store content.
--   4. Migration-first and fails SAFE: readDraftContent treats an absent column the
--      same as '{}', so shipping the code before applying this simply shows every
--      draft as nothing-captured. It cannot 500 a page.
--
-- STATUS IS NOT ALTERED HERE, and that is the point of the accompanying code change.
-- `status` keeps its column and its CHECK constraint but stops meaning "progress":
-- it is demoted to a pure RESUME POINTER (the furthest screen opened), while
-- completeness is derived from this column and stored nowhere. Before this, clicking
-- Continue three times set status='complete', which the hub rendered as "Ready to
-- submit" on a draft holding nothing -- the same green-check-a-lie the client gate
-- was put up to stop. Rows currently sitting at 'complete' with no content will
-- correctly read as nothing-captured after this; that is the correction landing.

begin;

alter table intellengine_drafts
  add column if not exists content jsonb not null default '{}'::jsonb;

insert into schema_migrations (version) values ('0074_intellengine_drafts_content') on conflict do nothing;
commit;
