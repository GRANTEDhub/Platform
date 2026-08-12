-- Application requirements of a grant, read off the NOFO and quote-verified against raw_text.
--
-- WHAT THIS IS. A structured, NOFO-derived list of what an APPLICATION to this program must
-- contain -- required narrative sections, page/format limits, required attachments,
-- evaluation/scoring criteria, and a freeform notes catch-all -- with every derived item
-- anchored to a verbatim span of the NOFO. Step 4 of the Pursuit build order
-- (docs/pursuit-state-audit-2026-08.md 5). It is read into the IntellEngine compliance step
-- via card_id -> review_cards -> grant, and rendered as an ADVISORY checklist that never gates.
--
-- GRANT-LEVEL, NOT PER-CLIENT. Requirements are a property of the NOFO: two clients pursuing
-- the same grant get identical requirements. So this is cached ONCE per grant here, never in
-- intellengine_drafts.content -- storing it per draft would re-extract per client and break the
-- "same NOFO = same requirements" invariant. Sibling in spirit to allowable_uses (0072) and
-- description_brief (0069): grant-level, enrichment only. Nothing in the occupancy/seat scorer
-- reads this column, so a list -- good, bad, or absent -- cannot move a fit score.
--
-- LAZY-ON-READ, NOT AN INGEST STEP AND NOT A SWEEP. Unlike allowable_uses (filled eagerly by a
-- bounded hourly cron across the whole corpus), this is derived on the FIRST compliance-step
-- open for a grant that is actually being pursued, by a staff-gated route, and cached here.
-- Two consequences for this migration:
--   1. It touches NONE of the six protected files. The generation path is a new
--      lib/grants/requirements.ts + a new staff-only API route; app/api/cron/ingest/route.ts,
--      lib/grants/pipeline.ts, engine.ts, queue.ts, gate.ts and lib/clients/match-queue.ts are
--      not in the diff. Adding columns to `grants` does not modify pipeline.ts -- this is
--      exactly what 0072 did.
--   2. NO PARTIAL "pending" INDEX, and that is a deliberate divergence from 0072. That index
--      exists to let an hourly sweep SCAN for unwritten rows (`allowable_uses is null and
--      attempts < 3`). There is no sweep here: every read fetches ONE known grant by its
--      primary key (grants.id = card.grant_id), which is already indexed. An index whose
--      predicate no query uses would be dead weight on a hot, heavily-written table. If a
--      backfill sweep is ever added (it is not planned), it lands with its own migration and
--      its own index, the same way 0072's index arrived with 0072's sweep.
--
-- THE RETRIEVABILITY GATE IS HARD, AND IT LIVES IN THE APP, NOT HERE. Generation derives
-- requirements ONLY when `shred_depth = 'full'` AND `raw_text` is present -- i.e. the row was
-- parsed from the real program NOFO. Otherwise it stores a `nofo_not_retrievable` sentinel and
-- REFUSES TO INFER; the compliance step then says the NOFO could not be read rather than
-- showing invented requirements. Same discipline as allowable_uses' reason field: an empty list
-- is ambiguous, so the reason is stored, not guessed.
--
-- WHY jsonb AND NOT typed columns. Each field is a LIST of items, each item a { text, quote }
-- PAIR (the quote is what makes a line checkable after the fact against raw_text), and the
-- shape is richer than allowable_uses' single list and will churn as steps 5-6 land. jsonb
-- absorbs that without a migration per field, and it matches the house pattern -- allowable_uses,
-- grants.scoring_rubric, clients.intake_data are all read whole through a tolerant reader
-- (lib/grants/requirements.ts::readApplicationRequirements) that treats anything unrecognised as
-- empty rather than throwing inside a page render.
--
-- Documented shape (enforced in app code, not by the DB):
--   {
--     "required_sections":   [ { "text": "...", "quote": "..." } ],
--     "page_format_limits":  [ { "text": "...", "quote": "..." } ],
--     "required_attachments":[ { "text": "...", "quote": "..." } ],
--     "evaluation_criteria": [ { "text": "...", "quote": "..." } ],
--     "other_notes":         [ { "text": "...", "quote": "..." } ],
--     "reason": null | "nofo_not_retrievable" | "no_requirements_found" | "all_dropped"
--   }
--
-- WHAT IS DELIBERATELY NOT A FIELD HERE. Eligibility, deadlines and match/cost-share are
-- already held as VERIFIED grant columns (eligible_entity_types / geographic_eligibility read
-- by computeEligibility; submission_deadline / deadline; cost_share). The extractor does NOT
-- re-derive anything we already hold structurally -- the only outcomes of re-extraction are
-- "same" (noise) or "contradiction" (a second, disagreeing source of truth). Those surfaces are
-- sourced from the existing columns; eligibility stays owned solely by the eligibility card so
-- the compliance step never shows two competing eligibility reads.
--
-- SAFETY PROPERTIES (why this is safe to apply to prod):
--   1. Three additive columns with defaults, on a feature gated off clients entirely
--      (PURSUIT_CLIENT_ACCESS_ENABLED) and off everyone until APPLICATION_REQUIREMENTS_CLIENT_VISIBLE.
--      No existing row, policy, trigger, index, matcher or send path is touched.
--      `add column if not exists` -- idempotent, safe to re-run.
--   2. No RLS change needed. grants' existing policies already cover a new column, and the read
--      path service-roles the grant (lib/intellengine/context.ts) while the write path is a
--      service-role route -- neither depends on a column-level grant. There is no way for this
--      to widen access.
--   3. No backfill. null reads as "not generated yet", which is true of every existing row.
--   4. Migration-first and fails SAFE: readApplicationRequirements treats an absent column the
--      same as null, so shipping the reader before applying this simply shows every grant as
--      requirements-not-generated. It cannot 500 a page. (The generate route writes this column,
--      so it ships only after the migration is applied -- migration-first as always.)

begin;

-- The artifact. Null = never generated. A non-null value with a `reason` sentinel is a real,
-- terminal answer (NOFO not retrievable / no requirements section / everything failed quote
-- verification) and must not be re-generated on every open -- see application_requirements_at.
alter table grants add column if not exists application_requirements jsonb;

-- Last SUCCESSFUL generation, where "successful" includes a verified sentinel: a NOFO that
-- cannot be read, or has no requirements section, is a real answer, not a failure, and must not
-- be re-derived on every compliance-step open. Mirrors allowable_uses_at / description_brief_at.
alter table grants add column if not exists application_requirements_at timestamptz;

-- Attempt counter, same three-strike shape as 0071/0072. Bounds retries on ONE grant whose text
-- can never yield a verifiable artifact (transient API failures, malformed model output) to 3
-- Anthropic calls total. This is a per-grant retry ceiling ONLY -- the request-rate bound is the
-- route's staff-only auth gate, not this counter. No index accompanies it because there is no
-- sweep scanning for `attempts < 3`; the check lives in the generate route, keyed by grant id.
alter table grants add column if not exists application_requirements_attempts integer not null default 0;

insert into schema_migrations (version) values ('0081_grant_application_requirements') on conflict do nothing;

commit;
