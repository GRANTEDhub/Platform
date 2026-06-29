-- ╔══════════════════════════════════════════════════════════════════════════╗
-- ║ match_attempts — observability for the matching engine                      ║
-- ╚══════════════════════════════════════════════════════════════════════════╝
-- review_cards only holds qualifying matches (fit >= 2). Everything else -- a
-- score of 1, a suppression, a disqualification, a pre-filter skip, an error --
-- was discarded silently, leaving no way to answer "why didn't this client
-- match?". That blocks calibration. This table records ONE row per (grant,
-- client) scoring attempt with the score, the reason, and the full result.
--
-- Written by the pipeline via the service client (bypasses RLS). Read access
-- mirrors review_cards: any authenticated user may read.
create table if not exists match_attempts (
  id                uuid primary key default uuid_generate_v4(),
  grant_id          uuid references grants(id) on delete cascade,
  client_id         uuid references clients(id) on delete cascade,
  outcome           text not null,   -- carded | below_threshold | suppressed | disqualified | prefiltered | error
  fit_score         int,             -- 1-3 when scored; null when prefiltered/errored
  suppressed        boolean default false,
  suppress_reason   text,
  disqualified      boolean default false,
  disqualify_reason text,
  prefilter_reason  text,
  error_detail      text,
  result            jsonb,           -- full match result (why_this_org, reasoning_context, etc.) when scored
  created_at        timestamptz not null default now()
);

create index if not exists match_attempts_grant_idx  on match_attempts(grant_id);
create index if not exists match_attempts_client_idx on match_attempts(client_id);

alter table match_attempts enable row level security;

drop policy if exists match_attempts_select on match_attempts;
create policy match_attempts_select on match_attempts for select
  using (auth.uid() is not null);
