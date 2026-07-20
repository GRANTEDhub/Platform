# Federal Register investigation → ingestion-reliability finding

**Status:** Closed (investigation only — no code changed)
**Date:** 2026-07-20
**Prod DB:** `Platform` (`gpqrzvnhxjsqerfczhqt`), ~702 grants — *not* the stale `Argo` project.
**Provenance:** live Grants.gov / Simpler.gov / Federal Register APIs (prior session) +
read-only Supabase MCP (schema) + SQL run by Shannon in the Supabase dashboard
(row reads are unavailable to the sandbox — no `execute_sql`).

---

## Question we started with

Why aren't the federal infrastructure grants our county/transit clients need
(DOT/FEMA/USDA/EPA) showing up in the platform, and would ingesting the Federal
Register (FR) fill the gap?

## Answer

**It is not a sourcing gap and FR is not the fix. It is an ingestion-reliability
bug: large/complex NOFOs time out on the 300 s manual-reprocess routes, land in
`status='error'` with no retry, and sit there unwatched. Infrastructure NOFOs are
exactly the big/complex documents this failure kills — which is the causal link
between the timeout bug and our thin DOT/USDA coverage.**

---

## Findings (all measured)

### Federal Register is not the answer
1. **No forecast lead-time.** For all 14 competitive NOFOs present on both FR and
   Grants.gov, they posted the same day (±2). FR gives zero timing advantage.
2. **Blind to FEMA/EPA/EDA competitive grants.** Zero competitive NOFOs from them
   in FR. FEMA's FR footprint is ~69 disaster declarations — pass-through money
   flow, not fundable postings.
3. **The competitive gap is ~82% timing / ~18% coverage.** 14 of 17 infra NOFOs
   were already on Grants.gov; only 3 were FR-only (IRP, Section 313A bond
   guarantees, BIA IGNITE — all loan/tribal-portal programs, not standard NOFOs).
4. **FR's only genuine value is pass-through visibility** — the FEMA Stafford Act
   declarations that release money to states and never become Grants.gov postings.
   Real but narrow; does not address competitive-grant coverage.

### Forecast pool shape (context)
5. Grants.gov forecast universe = 499; HHS = 412 (~83%); infrastructure = 3 total.
   Our HHS-heavy forecast pool is real, not an ingest artifact.

### The real finding — ingestion reliability
6. **We already hold DOT/USDA — not a sourcing gap.** Simpler carries DOT
   postings fine. Proof: **ICAM (FTA-2026-012, "FY2026 Innovative Coordinated
   Access and Mobility Pilot," CFDA 20.537) is in the DB** — `grant_status='Active'`
   but pipeline `status='error'`.
7. **19 grants stuck in `status='error'`.** 17 of 19 carry the watchdog message
   *"Stuck in processing (watchdog): pipeline did not complete…"* — the manual
   300 s-timeout failure mode (the ICAM mode). Named examples among the stuck set:
   ICAM, SCALE, PRIME.
8. **The timeout disproportionately kills big NOFOs (measured, ~3×).** Errored
   grants average ~53k chars of `raw_text` vs ~19k for completed. Infrastructure
   NOFOs (DOT/USDA) are precisely the long, attachment-heavy documents this hits.
   ICAM's own trace shows it: `shred_reason` = "2 attachment candidate(s) did not
   validate as a NOFO … additional_info_url did not yield a NOFO" — the deep shred
   burned wall-clock chasing attachment PDFs before matching even began.
9. **All 19 errors cluster in July 2026** — consistent with a one-time batch
   reprocess event rather than a steady drip.
10. **A few FR-flagged programs are genuinely absent** (e.g. Rail Vehicle
    Replacement, CRISI) — most likely the **forward-only discovery cursor**
    boundary (posted before go-live, not currently forecasted), *not* the timeout.
    A separate, minor coverage issue.

---

## Why it happens (code)

Two in-flight pipeline states, two failure paths; the health signal lives in
`grants.status` (pipeline), **not** `grants.grant_status` (the opportunity's own
status) — which is why a status/funder census (`grant_status='Active'`) shows these
as healthy DOT/USDA holdings. `status` and `grant_status` are distinct columns
(`types/database.ts:280,292`).

- **Manual reprocess routes** set `status='processing'` and run the full pipeline
  inline on a `maxDuration=300` function, in the background via `waitUntil`:
  `app/api/grants/ingest/route.ts:88,95`, `app/api/grants/[id]/rematch/route.ts:58`,
  `app/api/grants/backfill-reshred/route.ts:97`. A **function kill** (timeout /
  recycle) is *not* a thrown error, so the route's `.catch()` never fires and the
  grant stays `processing`. The watchdog then flips it to `error` **with no retry**
  (deliberate — "a human initiated it and can re-run in one click"):
  `lib/grants/watchdog.ts:29-40`. This is the ICAM mode (17 of 19).
- **Nightly cron drain** uses `status='matching'` (`lib/grants/queue.ts:108`);
  its watchdog path requeues up to `MATCH_MAX_RETRIES=2` then errors with a
  *different* message (`watchdog.ts:47-80`). "Move 2" already fixed the old
  cron-batch timeout by draining one grant at a time (`queue.ts:1-21`).
- **Still-capped surface:** `runMatching` scores the entire client roster inside a
  single 300 s window; a live tripwire WARNs past 180 s and notes the structural
  fix is still pending (`lib/grants/pipeline.ts:426,446-457`).
- **Forward-only discovery** (finding #10): cron pulls posted grants with
  `post_date ≥ latest_import − 2 days` plus a full walk of forecasted
  (`app/api/cron/ingest/route.ts:111-138`) — so a NOFO posted before go-live and
  not currently forecasted is never pulled. Absence ≠ reliability bug.

---

## Follow-ups (scoped for a FUTURE session — NOT done here)

1. **Immediate recovery.** The 19 stuck grants look one-click re-ingestable on a
   fresh 300 s window (ICAM / SCALE / PRIME / etc.). Confirm safe, then trigger.
   *Blocked on Shannon's go.*
2. **Permanent fix (scope-and-go; touches protected files).** Harden the manual
   reprocess routes against the 300 s cap (chunk/offload heavy shred), add retry
   for watchdog-killed shreds (the `processing` path is currently no-retry), and
   add a `status='error'` monitor so stuck grants don't sit unnoticed. Touches
   `app/api/cron/ingest/route.ts` and the manual routes — its own effort when ready.

---

## Verification notes / gaps
- Award amounts and CFDA numbers referenced here are best-effort identifiers for
  matching, not verified deliverable figures; the FON is the reliable key.
- Row-level facts were produced by SQL run in the Supabase dashboard (the sandbox
  has no `execute_sql`); the SQL used is preserved below for reproducibility.
- Domestic-only scope respected throughout; international/foreign hits (e.g. State
  Dept "Okinawa", U.S. Mission entries) were treated as false positives.

<details>
<summary>SQL used (run against Platform in the Supabase dashboard)</summary>

```sql
-- A. Pipeline-status census (headline count). Census on `status`, NOT grant_status.
select status, count(*) as n from grants group by status order by n desc;

-- B. Error population classified by failure signature.
select
  case
    when error_detail ilike 'Stuck in processing (watchdog)%' then 'watchdog_dead_shred (manual timeout)'
    when error_detail ilike 'Matching did not complete%'      then 'watchdog_dead_match (cron)'
    when error_detail ilike 'Grant row not found%'            then 'row_deleted_mid_run'
    when error_detail is null                                 then 'null_detail'
    else 'thrown_error'
  end as error_class,
  count(*) as n
from grants where status = 'error' group by 1 order by 1;

-- C. Raw stuck list.
select id, coalesce(funder,'(unshredded)') as funder, fon, grant_status,
       shred_depth, shred_reason, left(coalesce(error_detail,''),70) as err,
       processing_started_at, title
from grants where status = 'error' order by funder, processing_started_at;

-- D. Size/shred correlation (confirmed ~3x: error ~53k vs complete ~19k chars).
select status, count(*) as n, round(avg(length(raw_text))) as avg_raw_len,
       max(length(raw_text)) as max_raw_len,
       count(*) filter (where shred_depth = 'full')    as full_shred,
       count(*) filter (where shred_depth = 'summary') as summary_shred,
       count(*) filter (where shred_depth is null)     as null_shred
from grants where status in ('error','complete','processing','matching','queued')
group by status order by status;

-- E. FR-flagged programs: present? absent? what pipeline status?
select coalesce(funder,'(unshredded)') as funder, grant_status,
       status as pipeline_status, shred_depth, fon, assistance_listings,
       left(coalesce(error_detail,''),60) as err, title
from grants
where fon ilike '%FTA-2026-009%'
   or title ilike any (array['%rail vehicle replacement%','%consolidated rail infrastructure%',
        '%CRISI%','%intercity passenger rail%','%federal-state partnership%','%fed-state partnership%',
        '%community connect%','%distance learning%','%telemedicine%','%rural business development%'])
   or assistance_listings::text ilike any (array['%20.325%','%20.326%','%10.863%','%10.855%','%10.351%'])
order by pipeline_status, funder;

-- F. Errors over time (all 19 cluster in July 2026).
select date_trunc('month', processing_started_at) as month, count(*) as n
from grants where status = 'error' group by 1 order by 1;
```
</details>
