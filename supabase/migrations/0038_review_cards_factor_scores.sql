-- ╔══════════════════════════════════════════════════════════════════════════╗
-- ║ Per-factor match sub-scores (#105)                                          ║
-- ╚══════════════════════════════════════════════════════════════════════════╝
-- The scorer already reasons through 6 STRENGTH factors to reach fit_score. This
-- surfaces that per-factor reasoning as structured output: an ordinal rating
-- (strong | moderate | weak | insufficient_data) plus a one-line rationale for
-- each factor. Additive and DESCRIPTIVE ONLY -- it does not change fit_score, the
-- seat-ceiling clamp, or any scoring behavior.
--
-- Nullable by design: cards scored before this ships stay null and the UI renders
-- a "factor breakdown not yet scored" line -- no backfill, no re-score sweep.
-- Existing review_cards RLS covers the new column (no policy change needed).
--
-- Shape (per row):
--   { seat_role|eligibility|geographic|program_history|cost_share|mission:
--       { rating: 'strong'|'moderate'|'weak'|'insufficient_data', rationale: text } }

alter table review_cards add column if not exists factor_scores jsonb;
