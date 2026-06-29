-- ╔══════════════════════════════════════════════════════════════════════════╗
-- ║ match_feedback — analyst QA judgments on matches (calibration dataset)      ║
-- ╚══════════════════════════════════════════════════════════════════════════╝
-- Append-only log of human judgment on engine scores. Calibration lives here
-- now, not in prompt tuning: each row captures whether the analyst agreed, the
-- corrected score + reason if not, and a SNAPSHOT of the engine's state at the
-- time (so a later re-score never corrupts the labeled datapoint).
--
-- Keyed on the STABLE identity (grant_id + client_id) so feedback survives
-- re-scores. Provenance pointers (review_card_id, match_attempt_id) are nullable
-- + ON DELETE SET NULL: re-matching deletes/regenerates cards and writes new
-- attempts, but the feedback row persists -- the pointer just nulls. The
-- match_attempt_id pointer lets feedback reference a SUPPRESSED match (score 0,
-- no card) so false-negatives can be flagged later without re-architecting.
create table if not exists match_feedback (
  id               uuid primary key default uuid_generate_v4(),
  grant_id         uuid references grants(id) on delete cascade,
  client_id        uuid references clients(id) on delete cascade,
  review_card_id   uuid references review_cards(id) on delete set null,
  match_attempt_id uuid references match_attempts(id) on delete set null,
  agree            boolean not null,
  corrected_score  int check (corrected_score between 0 and 3), -- null when agree
  reason           text,
  engine_score     int,    -- snapshot at feedback time
  engine_seat_ref  text,   -- snapshot
  engine_reasoning jsonb,  -- snapshot of reasoning_context
  created_by       uuid references profiles(id) on delete set null,
  created_at       timestamptz not null default now()
);

create index if not exists match_feedback_grant_client_idx on match_feedback(grant_id, client_id);

alter table match_feedback enable row level security;

-- Append-only: authenticated users may read and insert; no update/delete policy
-- (the log is immutable through the API).
drop policy if exists match_feedback_select on match_feedback;
create policy match_feedback_select on match_feedback for select
  using (auth.uid() is not null);

drop policy if exists match_feedback_insert on match_feedback;
create policy match_feedback_insert on match_feedback for insert
  with check (auth.uid() is not null);
