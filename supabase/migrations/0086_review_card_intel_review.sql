-- ╔══════════════════════════════════════════════════════════════════════════╗
-- ║ review_cards.intel_review: the on-demand IntellEngine QA verdict (Brick 1)  ║
-- ╚══════════════════════════════════════════════════════════════════════════╝
--
-- The staff-triggered QA / review pass ("Run IntellEngine Intel") writes ONE column: an
-- Opus + web-verification verdict on a surfaced card. It is ANNOTATE-ONLY and PROPOSAL-ONLY
-- by construction -- it never writes fit_score / seat / decision / suppressed, so it can
-- never remove or re-score a card. The card keeps the engine's score; this column carries
-- "engine says 3, QA says 1, here's the web-grounded reason", and a human makes the call.
--
-- SHAPE (jsonb; see lib/grants/intel-review.ts IntelReview):
--   { verdict: 'affirm'|'demote'|'flag'|'unverified',
--     engine_fit_score, qa_fit_score (PROPOSAL, never applied), summary,
--     evidence: [{claim, source_url, quote}], fetched: [{url, ok, reason, finalUrl, fetchedAt}],
--     unverified, model, reviewed_by, reviewed_at }
--
-- NULL = no QA pass has run on this card yet -- which is every existing card and every card
-- until a staffer clicks the button. So this add is byte-identical to today on the live
-- surface: nothing reads the column until the on-demand route + the staff-only console panel
-- ship, and both no-op on null. There is no flag; the eval (RUN_INTEL_EVAL) is the "prove it"
-- gate, and the button simply doesn't exist client-side until this deploys.
--
-- STAFF-ONLY, NEVER CLIENT-FACING. This is raw internal QA voice. The client portal grant
-- query, the Grant Report, emails, and concept/PDF exports do NOT select this column and must
-- never start -- raw Intel is not a client artifact (org rule: paid-deliverable / client-
-- facing standards). It is structurally isolated by being a column only the staff console reads.
--
-- No index: read per-card on the console, never queried across. An index over "cards awaiting
-- QA" waits for the future AUTO-inline promotion (a separate build), not this on-demand one.
-- Adding a nullable jsonb column is a cheap metadata-only change (no table rewrite in modern
-- Postgres), so it stays inside the transaction wrapper + ledger insert.

begin;

alter table review_cards
  add column if not exists intel_review jsonb;

insert into schema_migrations (version) values ('0086_review_card_intel_review') on conflict do nothing;

commit;
