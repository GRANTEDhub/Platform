-- ╔══════════════════════════════════════════════════════════════════════════╗
-- ║ Outbound door — tokenized access links + first-class pipeline events         ║
-- ╚══════════════════════════════════════════════════════════════════════════╝
-- Step 1 of the client funnel: a prospect clicks a tokenized link in our grant-
-- forward email, lands on a thin Argo page that RECORDS the engagement, then
-- forwards to our Google Appointment Schedules booking page.
--
-- Built as PORTAL FOUNDATION on purpose: a future client login bolts onto the
-- same token table (polymorphic subject: prospect OR client; extensible action
-- type) without a rebuild. Pipeline status is DERIVED from events (like the
-- client-first gate / disposition), never a stored flag.

-- access_tokens: long, random, unguessable, expiring links. HASHED AT REST --
-- only sha256(raw) is stored, so a DB leak can't replay live links; the raw
-- token exists only in the URL we hand out.
create table if not exists access_tokens (
  id          uuid primary key default uuid_generate_v4(),
  token_hash  text not null unique,          -- sha256(raw); the raw token is never stored
  action_type text not null,                 -- 'prospect_schedule_call' (extensible; validated in app code, no CHECK)
  prospect_id uuid references prospects(id) on delete cascade,
  client_id   uuid references clients(id)  on delete cascade,   -- reserved for future client-portal / login tokens
  grant_id    uuid references grants(id)   on delete set null,  -- the grant the email featured
  expires_at  timestamptz not null,
  created_by  uuid references profiles(id),
  created_at  timestamptz not null default now(),
  -- A token must point at a subject. Prospect today; client is the reuse path.
  constraint access_tokens_subject_present check (prospect_id is not null or client_id is not null)
);
create index if not exists access_tokens_token_hash_idx on access_tokens (token_hash);
create index if not exists access_tokens_prospect_idx on access_tokens (prospect_id);

-- pipeline_events: append-only, first-class engagement log (who / what / when /
-- via-token). Never a status flag -- "in the pipeline" is DERIVED from the
-- presence of events. subject_snapshot keeps the event self-describing even if
-- the (non-durable) prospect row is later cleaned up.
create table if not exists pipeline_events (
  id               uuid primary key default uuid_generate_v4(),
  event_type       text not null,            -- 'clicked_schedule_call' (extensible)
  prospect_id      uuid references prospects(id) on delete set null,
  client_id        uuid references clients(id)  on delete set null,
  grant_id         uuid references grants(id)   on delete set null,
  token_id         uuid references access_tokens(id) on delete set null,
  subject_snapshot jsonb,                     -- {name, email?} captured at event time
  metadata         jsonb,                     -- ip / user-agent / referrer (best-effort)
  occurred_at      timestamptz not null default now()
);
create index if not exists pipeline_events_prospect_idx on pipeline_events (prospect_id);
create index if not exists pipeline_events_token_idx on pipeline_events (token_id);
create index if not exists pipeline_events_occurred_idx on pipeline_events (occurred_at);

alter table access_tokens  enable row level security;
alter table pipeline_events enable row level security;

-- Authenticated staff can read (pipeline visibility). The public /go/[token]
-- landing writes via the SERVICE role (bypasses RLS) because the prospect is
-- unauthenticated -- there is intentionally no anon insert policy.
drop policy if exists access_tokens_select on access_tokens;
create policy access_tokens_select on access_tokens for select
  using (auth.uid() is not null);

drop policy if exists pipeline_events_select on pipeline_events;
create policy pipeline_events_select on pipeline_events for select
  using (auth.uid() is not null);
