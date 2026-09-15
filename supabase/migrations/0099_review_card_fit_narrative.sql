-- 0099 — review_cards fit-analysis narrative: the dedicated, client-facing "why this client fits"
-- paragraph (separate from the QA verdict's qa_narrative).
--
-- Written by lib/grants/fit-analysis.ts — a NON-SCORING, render-layer Opus pass that reads the client's
-- profile (mission / funding_priorities / core_capabilities) + the grant's description_brief + the program's
-- state-level award history + the engine's role read, and produces the affirmative fit rationale for a
-- GO / MARGINAL card. It NEVER writes fit_score / seat / decision / qa_* (locked by test), so unlike the QA
-- judge it MAY read client_profile (#140 is scorer-only; reading the profile for a display narrative is fine).
-- It owns the go/marginal narrative; qa_narrative keeps demote/no-go. resolveFit picks by direction.
--
-- fit_narrative_fit_score snapshots the DISPLAYED (QA-coalesced) fit band the paragraph was written for; the
-- read layer (resolveFit) honors the narrative only while it still matches the current displayed score — one
-- rule that is BOTH the staleness guard AND the direction gate (a card that falls to no-go, by engine
-- re-score or QA demote, no longer matches a stored 2/3, so the narrative is withheld and the drain
-- regenerates it). Decoupled from the QA verdict lifecycle by construction: its own column, its own
-- generator, its own drain. fit_narrative_model records which model wrote it (for a later Sonnet A/B);
-- fit_narrative_at is the generation stamp (also the daily-cost ledger — the drain counts it, no run-log table).
--
-- CLIENT-SAFE by construction (narrativeGuard / stripSeatCodes at generation), so 0055's review_select
-- exposing every review_cards column to a client member is correct here — the same intent as qa_narrative
-- (0090). All writes are service-role (0089's guard_card_approval fast-path already permits them); no RLS
-- change. Nullable — absent = no narrative = today's assembled engine paragraph. FIT_ANALYSIS_ENABLED off
-- never writes these, so applying this ahead of the code (or with the flag off) is a pure no-op.
begin;

alter table review_cards add column if not exists fit_narrative text;
alter table review_cards add column if not exists fit_narrative_fit_score smallint;
alter table review_cards add column if not exists fit_narrative_model text;
alter table review_cards add column if not exists fit_narrative_at timestamptz;

insert into schema_migrations (version) values ('0099_review_card_fit_narrative') on conflict do nothing;
commit;
