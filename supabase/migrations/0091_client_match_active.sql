-- ╔══════════════════════════════════════════════════════════════════════════╗
-- ║ clients.match_active: reversible per-client matching pause (Lever A)          ║
-- ╚══════════════════════════════════════════════════════════════════════════╝
--
-- Most of the roster is real but not yet onboarded in the portal, yet the matcher
-- still scores every new grant against all of them — burning tokens (and QA budget)
-- on clients who can't act, and piling their alerts into the staff Review Queue.
-- This column is the reversible OFF switch: set match_active=false to pause a client,
-- flip it back to true when you onboard them.
--
-- The forward-matching gate is a one-line predicate the roster load in runMatching
-- (lib/grants/pipeline.ts, protected) carries: `.eq("match_active", true)`. It is
-- forward-only — un-pausing never re-scores the existing grant corpus, it only lets
-- new grants match the client again. The intel QA poller (lib/grants/intel-queue.ts)
-- skips paused clients the same way, and the staff Review Queue hides their matches
-- by default (a "Show paused" toggle keeps them reachable). Pausing NEVER mutates or
-- deletes an existing card — the existing alerts persist untouched, just filtered.
--
-- NOT NULL DEFAULT TRUE is load-bearing, not cosmetic: the gate is `.eq(...true)`, so
-- a NULL would read as "not true" and silently PAUSE a client. Defaulting true (and
-- forbidding null) means every existing and future row is matched unless deliberately
-- flipped off — so applying this ahead of the code is a no-op on the live surface
-- (nothing changes until the first client is set false by hand). A constant default
-- is a metadata-only add in modern Postgres (no table rewrite), so it stays inside the
-- transaction wrapper + ledger insert.

begin;

alter table clients
  add column if not exists match_active boolean not null default true;

insert into schema_migrations (version) values ('0091_client_match_active') on conflict do nothing;

commit;
