-- ╔══════════════════════════════════════════════════════════════════════════╗
-- ║ review_cards qa_* override columns: apply-the-gate QA (Step 3, PR B)         ║
-- ╚══════════════════════════════════════════════════════════════════════════╝
--
-- The IntellEngine QA pass is moving from PROPOSAL-ONLY (a side note in card_intel_reviews) to APPLYING its
-- verdict to the card. But it does NOT overwrite the engine's own columns — it writes to a SEPARATE override
-- layer, and the app displays coalesce(qa_fit_score, fit_score) at read time. Why this shape:
--   - REVERSIBLE + AUDITABLE: the engine's original fit_score / factor_scores are preserved untouched; QA's
--     applied score is a distinct layer. A wrong apply is a one-column revert (null the qa_* columns), never
--     a corrupted matcher record.
--   - OFF THE PROTECTED MATCHER PATH: the engine still writes fit_score in pipeline.ts (protected, unchanged);
--     QA writes these qa_* columns from the NON-protected drain (lib/grants/intel-queue.ts); the display
--     coalesce lives in the read/render layer. Zero protected-file touch.
--   - NEVER-HIDE is STRUCTURAL, not added here: review_cards has NO suppressed/disqualified column, so a
--     demote drives qa_fit_score to the floor and the row STILL surfaces. These columns cannot hide a card —
--     they can only lower the displayed score / rewrite the displayed factors, and the client card always
--     keeps surfacing. The raw "here's the real situation" analyst note stays STAFF-ONLY in card_intel_reviews
--     (0086, RLS is_staff() only); only the client-safe projection (score, factors, source URLs, status)
--     lands here.
--
-- RLS: review_cards' 0055 review_select is ROW-level with no column allowlist, so these columns ARE readable
-- by a client member for their own card — which is INTENDED: the corrected score / factors / sources SHOULD
-- reach the client card. They are NOT client-writable (review_write is staff-only; the drain writes
-- service-role). The raw staff voice is deliberately NOT here (it would leak via review_select) — it stays in
-- card_intel_reviews.
--
-- All columns NULLABLE; absent = QA has not applied = today's behavior. The apply-write is flag-gated
-- (AUTO_INTEL_APPLY, default OFF) — OFF, these columns stay null and the display coalesce is inert, so this
-- migration is byte-identical to today until the flag flips.
--
-- STALENESS: qa_engine_fit_score snapshots the engine score QA judged against. The read-layer applies the
-- override ONLY while qa_engine_fit_score = the current fit_score; when the engine re-scores (rematch), the
-- snapshot no longer matches, the override is treated as stale and ignored (engine score shown), and the
-- poller re-enqueues a fresh QA pass. This resolves the stale-verdict-on-rematch case as a read-side check
-- with zero protected-write touch.

begin;

alter table review_cards
  add column if not exists qa_fit_score int,                    -- applied score (1-3); client-facing; coalesced into the displayed score
  add column if not exists qa_factor_scores jsonb,              -- corrected six-factor object (same shape as factor_scores); the changed factor merged onto the engine's real factors by the drain
  add column if not exists qa_sources jsonb,                    -- the grounded source URLs shown on the card (client-safe: url + title only)
  add column if not exists qa_status text,                      -- applied | unverified | failed | none  (drives the "QA couldn't complete" surface)
  add column if not exists qa_engine_fit_score int,             -- snapshot of fit_score at apply time (staleness guard + one-column audit)
  add column if not exists qa_applied_at timestamptz,           -- when QA applied (mirrors the 0040 overridden_at audit convention)
  add column if not exists qa_reviewed_by uuid references profiles(id);  -- who applied; NULL = the automatic pass (mirrors card_intel_reviews.created_by)

-- Score bounds, mirroring the engine's 1-3 scale. NOT VALID would defer the full-table check; the columns are
-- all-null today so an immediate check is free.
alter table review_cards
  drop constraint if exists review_cards_qa_fit_score_range;
alter table review_cards
  add constraint review_cards_qa_fit_score_range
  check (qa_fit_score is null or (qa_fit_score >= 1 and qa_fit_score <= 3));

alter table review_cards
  drop constraint if exists review_cards_qa_engine_fit_score_range;
alter table review_cards
  add constraint review_cards_qa_engine_fit_score_range
  check (qa_engine_fit_score is null or (qa_engine_fit_score >= 1 and qa_engine_fit_score <= 3));

alter table review_cards
  drop constraint if exists review_cards_qa_status_values;
alter table review_cards
  add constraint review_cards_qa_status_values
  check (qa_status is null or qa_status in ('applied', 'unverified', 'failed', 'none'));

insert into schema_migrations (version) values ('0088_review_card_qa_override') on conflict do nothing;

commit;
