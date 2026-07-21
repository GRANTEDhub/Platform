# Federal Register investigation → grant-error triage (corrected 2026-07-20)

**Status:** Closed. Ingest-reliability half **corrected** — superseded sections flagged inline.
**Original:** commit 9143765 (same day). **Correction:** 2026-07-20, after a project-selector
read artifact was found.
**Prod DB:** Platform (`gpqrzvnhxjsqerfczhqt`), **783 grants**. Argo (`fjldesepdmjoqcxkxzap`),
**70 grants** — STALE, do not read.
**Provenance:** live Grants.gov / Simpler.gov / Federal Register APIs + read-only Supabase MCP
(schema/logs) + SQL run in the Supabase dashboard (the sandbox has no `execute_sql`).

---

## Correction notice — read first

The original version of this doc concluded there was an **ingestion-reliability / 300 s-timeout
problem** ("19 grants stuck, 17 manual-timeout, ~3× size skew"). **That half is retracted.** It
was built on a grants-table read that conflated the **stale Argo project (70 grants)** with prod
**Platform (783)**. Platform's real error population was **2 grants, both stale-opportunity-id
404s — not timeouts.**

The **Federal Register findings (Part A) were measured independently of the stuck-grant count and
still hold** — they are not affected by the Argo/Platform mixup. Corrected sections below are
marked **⛔ SUPERSEDED** with the replacement alongside; the original reasoning is kept, not
overwritten.

## Methodology lesson (new — the most durable takeaway)

- **Always confirm the Supabase project selector before trusting any count.** The dashboard
  silently remembers the last-selected project; queries across one session can land on different
  databases without warning.
- **Census tell:** `select count(*) from grants` → **783 = Platform, 70 = Argo**. Run it first,
  and re-run it whenever a count surprises you.
- **The contradiction was the alarm.** A *stricter* filter returned MORE rows than a *looser* one
  (Step 0 `status='error' AND watchdog%` = 17 vs. dump `status='error'` = 2). `A AND B ⊄ A` is
  impossible on one table — that signature means two different DBs were read. Treat it as a
  project-selector alarm, not a data mystery.

## Question we started with

Why aren't the federal infrastructure grants our county/transit clients need (DOT/FEMA/USDA/EPA)
showing up in the platform, and would ingesting the Federal Register (FR) fill the gap?

## Part A — Federal Register (measured independently; STILL HOLDS)

1. **No forecast lead-time.** All 14 competitive NOFOs on both FR and Grants.gov posted the same
   day (±2). FR gives zero timing advantage.
2. **Blind to FEMA/EPA/EDA competitive grants.** Zero competitive NOFOs from them in FR; FEMA's FR
   footprint (~69 disaster declarations) is pass-through money flow, not fundable postings.
3. **~82% timing / ~18% coverage.** 14 of 17 infra NOFOs were already on Grants.gov; only 3 were
   FR-only (IRP, Section 313A bond guarantees, BIA IGNITE — loan/tribal-portal programs).
4. **FR's only genuine value is pass-through visibility** — FEMA Stafford Act declarations that
   release money to states and never become Grants.gov postings. Real but narrow.
5. **Forecast pool shape:** 499 forecasted; HHS = 412 (~83%); infrastructure = 3. The HHS-heavy
   pool is real, not an ingest artifact.

*Re-affirmed this session:* DOT/USDA/SBA programs are live on Grants.gov (STEP `SB-OIT-STEP-2026-01`,
PRIME `SB-OCAPR-26-001`, SCALE `SB-OIIGA-26-001`; ICAM `FTA-2026-012` present in the DB) — consistent
with FR adding no competitive-coverage value.

## Part B — the grant-error population (CORRECTED)

> **⛔ SUPERSEDED (original findings 6–10):** "19 stuck in error / 17 from the manual-reprocess 300 s
> timeout / all clustered July 2026." Retracted — an Argo-vs-Platform read artifact. The "17" set
> (ICAM / BLM JFSP / NIH U54 / ~12 full) did not correspond to Platform's true error rows.

**✅ True Platform picture — 2 errored grants, both stale-opportunity-id 404s (not timeouts):**

- **STEP `SB-OITST-26-001`** — stale duplicate; a healthy FY26 row (`SB-OIT-STEP-2026-01`,
  complete/full) already exists → **soft-closed** as a grant-level skip (`status='complete'` +
  `skip_reason`), non-destructive. **Done.**
- **PRIME `SB-OCAPR-26-001` (errored row)** — a real orphan, no healthy FY26 row → **re-pointed in
  place** to the live FY26 Simpler id (`c55857c6-55ef-453b-b9ce-37c31ba73a5b`). Currently
  **`queued`, awaiting the drain — final verify pending** (not yet re-shred/re-matched). Carried 2
  review cards + 20 attempts from an earlier summary-shred match; re-match preserves decided cards
  and rebuilds pending ones (`pipeline.ts:339-348,414-431`).
- **SCALE `SB-OIIGA-26-001`** — self-corrected: re-pointed to the current FY26 id, currently
  **`queued`, awaiting the drain — final verify pending.**

**Not a sourcing gap.** Simpler carries DOT/USDA — the holdings census (on Platform, ~700-row scale)
showed DOT-FTA / FHWA / MARAD / NIFA / RBCS present, and ICAM `FTA-2026-012` is in the DB.

**Not a timeout residual.** No watchdog `"Stuck in processing"` errors exist on Platform — the enqueue
filter for that string matched **zero** rows.

> **⛔ Retracted causal claim: "3× size ⇒ timeout."** Confounded. Full shreds store up to 100 000
> chars of NOFO text *by design* (`pipeline.ts:204`); a summary shred stores the API JSON. So
> errored-and-full grants having larger `raw_text` reflects shred-depth composition, not timeouts.
> The number never demonstrated causation.

## The real recurring failure mode (replaces the timeout thesis)

1. **Stale opportunity ids after the forecast→active flip.** A stored Simpler `opportunity_id`
   (UUID) is not guaranteed to survive the flip (`app/api/cron/ingest/route.ts` header note), so a
   later re-shred can `404`. **Fix = re-point `source_url` to the live id, not re-shred the stale
   one** (a plain re-shred re-fetches the dead id and re-404s). This is exactly the STEP/PRIME/SCALE
   pattern.
2. **NOFO-resolver gap (`lib/grants/nofo.ts`).** `resolveNofoText` can't validate a NOFO behind a
   portal/attachment wall ("additional_info_url did not yield a NOFO") → the grant lands at a thin
   *summary* shred. Independent of the shred window; the fix is resolver/attachment handling.

## The timeout mechanism (accurate — but produced NONE of the observed errors)

The two-stage lifecycle and watchdog are real and worth knowing: manual reprocess routes set
`status='processing'` on a 300 s function and a kill leaves it stuck → watchdog flips to `error`
with `"Stuck in processing"` (`lib/grants/watchdog.ts:29-40`); the cron drain uses `matching` with a
2-retry path (`lib/grants/queue.ts`). `runMatching` still scores the whole roster in one 300 s window
(tripwire at 180 s, `pipeline.ts:446-457`). **Kept for the reasoning trail — but zero of Platform's
current errors came from this path.** If one ever does, it will carry a `"Stuck in processing"` or
`"Matching did not complete"` `error_detail`; none exist today.

## Follow-ups — DE-JUSTIFIED (noted, not actioned)

> **⛔ Both original follow-ups are retracted by the corrected data.**
1. "Immediate recovery of the 19 stuck" — there were **2**, handled individually (soft-close /
   re-point). No batch recovery exists to run.
2. "Permanent fix: harden the 300 s window / chunk-offload + retry + error monitor" — **no timeout
   residual existed to justify it.** The roster-match 300 s ceiling remains a *theoretical*
   preventive (the `pipeline.ts` tripwire), not a demonstrated problem, and is **not scoped.** It
   would touch protected files (`app/api/cron/ingest`, the manual routes) — **left untouched**, per
   scope boundaries.

A `status='error'` monitor is still mildly worthwhile (it would have surfaced these 2 dups without a
manual hunt), but it's a small nicety, not the "systemic timeout leak" the original doc implied.

## Verification notes / gaps

- Row facts came from SQL in the Supabase dashboard; counts are authoritative **only when the
  project selector is confirmed** (see Methodology lesson).
- **ICAM `FTA-2026-012`:** present in the DB (DOT ingestion works), but its exact current Platform
  status was **not separately re-verified** after the correction. It is **not** in the confirmed
  2-grant error set; its earlier "error" reading fell inside the project-ambiguity window.
- **PRIME and SCALE are `queued`, awaiting the drain** — re-run the verify query after the drain to
  confirm each reaches `complete` / `shred_depth='full'`. If either re-errors with an HTTP 404, the
  re-pointed id is still wrong.
- STEP/PRIME/SCALE FY26 opportunities confirmed live on Grants.gov (ids 363144 / 363196 / 363089).
  Simpler's API is keyless-401, so the live Simpler UUID for the PRIME re-point was taken from the
  Simpler site.

<details>
<summary>SQL used (corrected — run against Platform, selector confirmed)</summary>

```sql
-- Census with project tell. 783 = Platform, 70 = Argo. Run FIRST.
select (select count(*) from grants) as total_grants,
       status, count(*) as n
from grants group by status order by n desc;

-- The real error population (2 rows: STEP, PRIME) with the actual failure reason.
select id, funder, fon, status, shred_depth, source_url,
       left(coalesce(error_detail,''),60) as err, shred_reason, title
from grants where status = 'error' order by funder;

-- STEP: soft-close the stale 404 duplicate (non-destructive). DONE.
update grants
set status='complete',
    skip_reason='Superseded: stale duplicate of SB-OIT-STEP-2026-01 (Grants.gov 363144); source 404s on Simpler',
    error_detail=null
where id='0f47f7f9';

-- PRIME: re-point the SAME row to the live FY26 id, then let the drain re-shred+match. DONE (queued).
-- (Do NOT re-ingest via URL — the ingest FON dedup would return the errored row unchanged.)
update grants
set source_url='https://simpler.grants.gov/opportunity/c55857c6-55ef-453b-b9ce-37c31ba73a5b',
    shred_depth=null, status='queued', error_detail=null, match_retry_count=0
where id='f74e982b';

-- Verify after the drain runs (PRIME + SCALE should reach complete / full):
select id, funder, fon, status, shred_depth, source_url,
       left(coalesce(error_detail,''),50) as err
from grants where id in ('f74e982b','0f47f7f9') /* + SCALE id */ order by funder;
```

*Retracted query — do not reuse:* the `avg(length(raw_text))` error-vs-complete size comparison.
It's confounded by shred-depth composition and proves nothing about timeouts.
</details>
