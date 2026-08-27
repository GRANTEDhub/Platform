-- ╔══════════════════════════════════════════════════════════════════════════╗
-- ║ Auto-inline IntellEngine QA: the work queue + the cost log (Step 3, PR 1)   ║
-- ╚══════════════════════════════════════════════════════════════════════════╝
--
-- The on-demand QA pass (card_intel_reviews, 0086) is now going AUTOMATIC: a poller enqueues a QA job
-- for every surfaced (grant, client) pending card that has no verdict yet, and a drain cron runs
-- runIntelReview on each and writes the verdict to card_intel_reviews. PROPOSAL-ONLY is unchanged — the
-- drain writes card_intel_reviews ONLY, never review_cards.fit_score / seat / decision / suppressed, so
-- auto-QA can never remove or re-score a card (H1: cards surface immediately; the verdict attaches when
-- ready). Everything here is gated behind AUTO_INTEL_ENABLED (default OFF); OFF = the tables sit empty
-- and nothing runs, byte-identical to today.
--
-- ZERO protected-file touch: the enqueue is a POLLER cron (finds eligible cards), not a hook in the
-- protected pipeline.ts. Staff-only RLS on both tables, all writes service-role (the 0080/0086 pattern).

begin;

-- ── The work queue ────────────────────────────────────────────────────────────────────────────────
-- Keyed on the (grant, client) PAIR, not the review_card id: the drain resolves the CURRENT pending
-- card for the pair at run time, so a re-insert of the card (new id) can't orphan a job, and a
-- re-score after a rematch-clear re-enqueues the same pair. One live job per pair (unique).
create table if not exists intel_review_queue (
  id uuid primary key default gen_random_uuid(),
  grant_id uuid not null references grants(id) on delete cascade,
  client_id uuid not null references clients(id) on delete cascade,
  status text not null default 'queued',  -- queued | processing | done | error
  attempts int not null default 0,
  error_detail text,
  enqueued_at timestamptz not null default now(),
  started_at timestamptz,
  finished_at timestamptz,
  updated_at timestamptz not null default now(),
  unique (grant_id, client_id)
);
create index if not exists intel_review_queue_status_idx on intel_review_queue (status, enqueued_at);

alter table intel_review_queue enable row level security;
-- Staff read only; every write is service-role (the cron). No client-member policy: a portal member
-- has no policy that admits them, matching card_intel_reviews / the grantbot tables.
drop policy if exists intel_review_queue_staff_select on intel_review_queue;
create policy intel_review_queue_staff_select on intel_review_queue for select using (public.is_staff());

-- ── The per-run cost / outcome log ────────────────────────────────────────────────────────────────
-- Append-only, one row per auto-QA run (NOT per queue row — queue rows are reused, so they can't hold
-- history). The drain sums today's cost_estimate_usd before running to enforce the daily ceiling
-- (INTEL_AUTO_DAILY_CAP_USD). No FKs on the id columns on purpose: the cost/audit trail must survive a
-- card / grant / client deletion.
create table if not exists intel_auto_run_log (
  id uuid primary key default gen_random_uuid(),
  grant_id uuid,
  client_id uuid,
  review_card_id uuid,
  verdict text,
  searches int,
  cost_estimate_usd numeric not null default 0,
  ran_at timestamptz not null default now()
);
create index if not exists intel_auto_run_log_ran_at_idx on intel_auto_run_log (ran_at);

alter table intel_auto_run_log enable row level security;
drop policy if exists intel_auto_run_log_staff_select on intel_auto_run_log;
create policy intel_auto_run_log_staff_select on intel_auto_run_log for select using (public.is_staff());

insert into schema_migrations (version) values ('0087_intel_review_queue') on conflict do nothing;
commit;
