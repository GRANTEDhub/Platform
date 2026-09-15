-- 0100 — review_cards.fit_narrative_edited: a human-edit LOCK on the fit-analysis narrative.
--
-- The fit-analysis narrative (migration 0099, lib/grants/fit-analysis.ts) is a machine-written,
-- client-facing "why this client fits" paragraph that a background cron drain regenerates whenever
-- the displayed score moves. A staffer needs to correct that paragraph before it goes in front of a
-- client (the alert PDF now carries it), and that correction must NOT be silently overwritten by the
-- next drain pass. This column is that lock.
--
-- WHEN TRUE:
--   • The drain (runFitAnalysis) NEVER regenerates the card's fit_narrative — fitNarrativeStale returns
--     false and the poll query filters the card out, so a human edit is never clobbered.
--   • resolveFit (lib/report/qa-override.ts) honors the stored (human) narrative on ANY displayed
--     go/marginal (2/3) score REGARDLESS of the fit_narrative_fit_score snapshot — so the edit survives
--     a benign band move (a rematch nudging 3→2) instead of being withheld the moment the snapshot goes
--     stale. The DIRECTION gate is unchanged: the narrative is still withheld on a no-go (displayed-1)
--     or an applied QA demote, so a human edit can never contradict the go/no-go call.
--
-- THE UNLOCK is the on-demand regenerate (runFitAnalysisForCard, the admin route): it bypasses the
-- drain's skip and buildFitPatch writes fit_narrative_edited=false, so a deliberate machine regenerate
-- clears the human lock. The cron drain, which never reaches an edited card, can only ever clear it via
-- that explicit path.
--
-- Default false = byte-identical to today (the drain and resolveFit behave exactly as pre-0100). All
-- writes are service-role (0089's guard_card_approval fast-path already permits them); no RLS change.
-- Applying this ahead of the code is a pure no-op; the code that SELECTs this column must not deploy
-- before it is applied (the drain's poll references it).
begin;

alter table review_cards add column if not exists fit_narrative_edited boolean not null default false;

insert into schema_migrations (version) values ('0100_review_card_fit_narrative_edited') on conflict do nothing;
commit;
