-- ╔══════════════════════════════════════════════════════════════════════════╗
-- ║ Close a grant for prospecting — drops it from the prospect pane, keeps history ║
-- ╚══════════════════════════════════════════════════════════════════════════╝
-- An admin can "Close" a grant from the intel prospect pane: it leaves the
-- prospect feed but persists in the Ledger with its prospect history intact. A
-- future Ledger action can reopen it. Represented as a dedicated nullable
-- timestamp (null = open for prospecting; set = closed) -- NOT overloaded onto
-- grant_status (source/lifecycle-driven, overwritten on re-ingest) or skip_reason
-- (the structural "never prospectable" ingest gate). Explicit, reversible,
-- auditable (when + who), and needs no backfill: every existing grant reads open.
--
-- The prospect feed (lib/grants/gate.ts: getProspectFeed + releasedGrantsForProspecting)
-- gains `prospecting_closed_at is null`, so a closed grant drops out in one place.
-- Reopen = set prospecting_closed_at back to null (future Ledger function).

alter table grants add column if not exists prospecting_closed_at timestamptz;
alter table grants add column if not exists prospecting_closed_by uuid references profiles(id);
