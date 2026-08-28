-- 0090 — review_cards.qa_narrative: the client-safe QA fit narrative (Step C, display half).
--
-- The QA pass (FIT_NARRATIVE_ENABLED) writes ONE client-safe integrated paragraph on an applied demote —
-- rationale → grounding reality → proposed role → net score, one voice, no scoring machinery (generated +
-- faithfulness-guarded in lib/grants/fit-narrative.ts, proven in the intel-review eval). This column is where
-- the apply-write projects it, and the read layer (resolveFit) replaces the assembled engine fit-factor
-- paragraph with it on an applied+fresh card.
--
-- CLIENT-SAFE by construction (the narrativeGuard nulls any staff-voice/machinery leak at generation time),
-- so unlike the raw staff `summary` (card_intel_reviews, is_staff() only) it is INTENDED to be client-
-- readable — 0055's review_select already exposes every review_cards column to a client member, which is
-- correct here. It is a qa_* OVERRIDE column (nullable; absent = no narrative = today's assembled paragraph),
-- cleared on any non-demote re-QA by the same buildQaPatch clearing patch that nulls the score columns, and
-- honored only while qa_engine_fit_score === fit_score (the staleness read-guard). No RLS change; the
-- guard_card_approval service-role fast-path (0089) already permits the apply-write's service-role UPDATE.
begin;

alter table review_cards add column if not exists qa_narrative text;

insert into schema_migrations (version) values ('0090_review_card_qa_narrative') on conflict do nothing;
commit;
