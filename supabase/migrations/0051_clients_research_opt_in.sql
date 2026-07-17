begin;

-- Research-grants opt-in, per client (migration 0051).
--
-- GRANTED does not pursue research grants, so the forecasted "on the horizon"
-- relevance pass excludes research funders (NIH) for everyone by default
-- (isResearchExcludedFunder in lib/grants/forecast-relevance.ts). This flag is the
-- per-client override: checking the box on the Add/Edit Client form (shown only for
-- small_business / higher_education org types -- the only plausible research applicants)
-- sets this true, which flows to isResearchExcludedFunder({ optIn: true }) via the
-- client's horizon call, so NIH/research grants become eligible for THAT client only.
--
-- Default false, NOT NULL: every existing and new client stays opted OUT. No backfill --
-- we are adding the switch, not flipping it.
alter table clients add column if not exists research_opt_in boolean not null default false;

insert into schema_migrations (version) values ('0051_clients_research_opt_in') on conflict do nothing;

commit;
