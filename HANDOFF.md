# Handoff — prospect one-time-match ("Tara's tool") — 2026-07-13

Cold-start doc for a fresh Code thread. Read `CLAUDE.md` first; this layers the
session context on top. The immediate blocker is the **budget-stop overrun** (§4).

---

## 0. TL;DR

- Goal: adding a **prospect** (a `clients` row toggled prospect) fires a **one-time
  match against the current grant pool (~45 grants)**; results render on its client
  dashboard with an in-progress state until done. NOT recurring daily matching.
- Built as an **enqueue/drain queue** mirroring the grant matching queue. Enqueue +
  resume + self-heal all **work**. UI progress + partial-safety **work**.
- **One open blocker:** a single drain invocation does not stop at its 210s budget —
  it still runs to the Vercel 300s kill. Resume papers over it (each call makes real
  progress and it self-heals via cron), so it's a robustness bug, not data loss —
  but it must be fixed before Tara/prod use. Two prior fix attempts did not resolve
  it; see §4 for the strongest leads (start by confirming the deployed commit).
- Branch `claude/alert-pdf-cost-share-di6c1l` @ `0a5110d`, **no PR opened**, 6 commits
  on top of `main` (`fb89a53`). Migration **0045 is applied to prod**.

---

## 1. Locked architecture & invariants (do not violate)

- **Occupancy is profile-free (incident #138→#140).** `matchGrantToClient` (`lib/grants/engine.ts`)
  scores seat/NONE on grant + rubric + raw client fields ONLY. `client_profile` must
  never feed occupancy — a distilled profile pushed the scorer into strict itemized
  seat-matching and buried integrative-fit clients. Guarded by the seat-stability
  `profileInvariant` flag.
- **Seat menu + code clamp (#132).** The model returns a `seat_ref` from a CLOSED menu
  (`buildSeatMenu`) plus `entity_required`; the numeric fit ceiling is derived/clamped
  **in code**, the model does not pick the final number. A required, seated entity
  cannot be zeroed (eligibility floor). Prompt lesson from #132: **positive directive,
  not descriptive prohibition.** Any scorer change must re-pass the seat-stability
  harness (see §6).
- **`enrichMatchWithProfile` is structurally isolated.** It's a SEPARATE call that runs
  only for surfacing matches (fit ≥ 2), grounds narrative (why-this-org / concept /
  draft email) from `client_profile`, and **cannot change the seat/score** — its tool
  schema has no occupancy fields; the merged result takes occupancy from Phase-1 only;
  falls back to Phase-1 narrative on any failure.
- **`scoreGrantClientPair` is the single per-pair path (`lib/grants/pipeline.ts`).** Both
  the grant-centric batch (`runMatching`, one grant → roster) and the client-centric
  one-time match (`drainClientMatchQueue`, one client → pool) call it, so a card is
  identical regardless of which orientation minted it. It was extracted verbatim from
  `runMatching`; occupancy is untouched. Callers own the decided-card spend skip.
- **Roster/lead invariant.** `runMatching` scores a `clients` row iff
  `pipeline_stage IS NULL OR = 'converted'` (`NON_LEAD_OR_FILTER`, `lib/leads/stage.ts`).
  A prospect MUST carry a non-null, non-'converted' stage (`discovery_pending`) or the
  daily batch would score it. `isUnconvertedLead(stage)` = `stage != null && != 'converted'`.
- **Migration ledger discipline (0044+).** Every migration ends with
  `insert into schema_migrations (version) values ('<stem>') on conflict do nothing;`
  inside `begin; … commit;`. **Migration-first; the USER applies to prod** (service SQL).
  Never run prod migrations from the sandbox (can't reach prod Supabase/Anthropic).
- **Preview-verify gate.** CI green is necessary, not sufficient. Client-facing / infra
  changes get look-before-merge on the REAL deploy (`app.grantedco.com`, hard-refresh
  for Cloudflare — not `*.vercel.app`). **Crons run production-only**; previews are
  exercised via admin-session on-demand routes.
- **Other locks:** sanitize = `sanitize-html` (never jsdom/dompurify, incident #72);
  absolute emailed links via `appBaseUrl()`; emails plain-text + PDF; send gate
  `canSendOutreach`; brand tokens from `lib/brand.ts`. Domestic-only (U.S.); prime vs
  partner/sub never conflated; award amounts labeled estimates.

---

## 2. Shipped this session (commit hashes)

Merged to `main` earlier this session (PRs):
- **#142** — intake narrative capture (mission/programs/priority areas/partnerships).
- **#143** — client/prospect toggle on the intake + admin form; prospect written
  `status='lead'` + `pipeline_stage='discovery_pending'` server-side; service_area chip;
  edit-time kind-flip logs a `pipeline_events` row (fixed a VADE-caught bug where every
  edit rewrote lifecycle fields — now only on a genuine flip).
- **#144** — intake cleanup: nav renames, removed admin SAM/federal hand-entry, matcher
  controls grouped as a strength ladder. Merge commit **`fb89a53`** (branch base).

On branch `claude/alert-pdf-cost-share-di6c1l` (NOT merged, no PR):
- **`a3bfafa`** — migration `0045_clients_initial_match_status.sql` (adds
  `clients.initial_match_status`). **Applied to prod 2026-07-13 17:11 UTC.**
- **`1b88527`** — first build of the one-time match: extracted `scoreGrantClientPair`
  from `runMatching`; per-client run helper; prospect-only trigger; progress banner +
  `AutoRefresh` (relocated to `components/ui/auto-refresh.tsx`); `initial_match_status`
  on the `Client` type.
- **`94060db`** — client-form validation errors return `{ error }` inline instead of
  throwing (a thrown server-action error 500s). `redirect()` kept outside try/catch so
  `NEXT_REDIRECT` isn't swallowed. Fixed both create and edit.
- **`9e89458`** — **queue/drain redesign** (replaces the single-shot run):
  `lib/clients/match-queue.ts` (`drainClientMatchQueue`), `/api/cron/client-match`
  (Bearer, prod, cron `5-59/10`), `/api/clients/drain-match-queue` (admin-session,
  browser-openable for preview), enqueue at insert (`initial_match_status='queued'`),
  removed `lib/grants/initial-match.ts`, dashboard progressive "scored X of Y" + the
  Grant-activity chart gated while running (partial cards must never read as a finished
  report), `vercel.json` cron. **No migration** (resume derives remaining by diffing the
  pool against `match_attempts`).
- **`ccc4053`** — submit pending state + double-submit guard on the client form (root
  cause of "phantom duplicate": successful create redirected but gave no feedback, user
  resubmitted into the row they just made).
- **`0a5110d`** — attempted budget-stop fix (race worker pool vs a hard deadline; budget
  240s→210s; `[client-match-timing]` log). **DID NOT RESOLVE the overrun** (see §4).

---

## 3. Repo / branch state

- Branch: `claude/alert-pdf-cost-share-di6c1l`, head `0a5110d`, pushed, clean tree.
- Base: `main` @ `fb89a53` (#144 merge). Branch is 6 commits ahead. **No PR opened.**
- Migration 0045 applied to prod; confirmed in `schema_migrations`.
- tsc + `next build` clean at head (only the pre-existing handlebars/webpack warning).
- Per CLAUDE.md branch discipline: this branch name was reused after #144 merged and
  reset off latest `main`; keep developing here, reset off `main` again once this merges.

---

## 4. OPEN BUG #1 — drain doesn't stop at budget (the blocker)

**Symptom (preview):** reset a prospect (`29noc8y4`) to `initial_match_status='queued'`,
hit `/api/clients/drain-match-queue` → **`Vercel Runtime Timeout Error: Task timed out
after 300 seconds`**, and **NO `[client-match-timing]` log line appears**. So
`drainClientMatchQueue` never reaches its final log/return before the platform kill.

**What's proven working (do NOT touch):** attempts-diff **resume** — after a 504,
hitting the route again picks up where it left off (observed 29→35→continuing). It
self-heals via the cron (`5-59/10`). This is a "single invocation must return cleanly"
bug, not data loss — low urgency, but required before Tara/prod use.

**What was tried and did NOT work:** `0a5110d` races the worker `Promise.all` against a
`setTimeout(210s)` deadline and clears the timer if workers win. Theory was: return at
210s regardless of slow in-flight pairs (abandoned pairs are caught in
`scoreGrantClientPair`, re-scored on resume). It still 300s-kills with no timing log.

**Strongest leads for the fresh thread (in order):**

1. **FIRST: confirm the preview actually deployed `0a5110d`.** "Same 300s timeout AND no
   `[client-match-timing]` line" is *exactly* what `9e89458` (no race, no timing log)
   would produce. If the preview is stale (wrong preview URL, un-promoted deploy, or an
   Instant-Rollback pin per CLAUDE.md), the fix was never exercised. Verify the deploy's
   git SHA before assuming the race is broken. If stale → redeploy head and re-test; the
   race may already work.

2. **If `0a5110d` IS deployed:** the likely real issue is that **abandoning in-flight
   promises does not stop them.** On Vercel the invocation stays alive until the event
   loop drains OR `maxDuration`; abandoned worker fetches (especially in 429 backoff)
   keep the loop busy, the platform hits 300s and emits the Runtime Timeout — and if the
   handler is somehow still parked, the post-loop log never prints. A `Promise.race` that
   leaves dangling work cannot beat a platform-level wall-clock kill.
   - Check whether the drain is actually stuck **inside** `scorePairsWithinBudget` vs a
     surrounding `await` (e.g. `loadPool` does `select *` on ~45 grants incl. `raw_text`,
     up to ~4.5 MB; or `scoredGrantIds`). Add a log right after `loadPool` and right
     after the race to localize where the 300s is spent.

3. **Robust fix direction (scope, don't rush):** make in-flight calls actually STOP at
   the deadline instead of being abandoned — thread an `AbortController`/`AbortSignal`
   from the drain → `scoreGrantClientPair` → `matchGrantToClient` / `enrichMatchWithProfile`
   → the Anthropic SDK (`messages.create(params, { signal })`), and abort at the deadline
   so the event loop drains and the function returns cleanly. Simpler alternatives to
   weigh: (a) shrink each invocation to a **small fixed batch** (e.g. 8–10 pairs) and
   return, leaning entirely on cron/resume — smallest per-invocation work, guaranteed
   under cap; (b) lower the SDK `maxRetries` (fewer/shorter 429 backoffs) so pairs are
   short and `Promise.all` finishes naturally well under 300s without abandonment.

**Still unconfirmed:** whether the pool runs at true concurrency 6 or is throttled toward
1 by 429 backoff. The `[client-match-timing]` log (`peakInFlight=…/6`, `scoredPairs`,
`wallMs`) was added to answer this but has never printed because the function is killed
first. Once §4 is fixed and the log appears, read `peakInFlight`: ≈6 = parallel (low
throughput ⇒ rate-limit backoff, tune CONCURRENCY/retries); ≈1 = a real serialization
bug. `getAnthropicClient()` news a client per call with no limiter, so the code is
structurally concurrent — backoff is the prime suspect.

Key files: `lib/clients/match-queue.ts` (drain + budget), `lib/grants/pipeline.ts`
(`scoreGrantClientPair`), `lib/grants/engine.ts` (`matchGrantToClient`,
`enrichMatchWithProfile`), `lib/anthropic.ts` (`getAnthropicClient`, `MODEL`).

---

## 4b. OPEN BUG #2 — navigation gap (prospect dashboard is stranded)

A prospect is a `clients` row with `pipeline_stage='discovery_pending'`. It appears in
**Pipeline (`/leads`)** but NOT in **Clients/Leads (`/clients`)** because the clients
list filters with `NON_LEAD_OR_FILTER` (`app/(app)/clients/page.tsx:19`), which excludes
un-converted leads. The one-time-match results + the progress banner live on the client
dashboard **`/clients/[id]`** (`app/(app)/clients/[id]/page.tsx`) — reachable only via the
post-create redirect. The lead detail view (`app/(app)/leads/[id]/page.tsx`) has **no
link to `/clients/[id]`**, so once the user navigates away the prospect's match results
are orphaned.

Fix options for the fresh thread (decide with Shannon): add a "View match dashboard"
link from the lead view to `/clients/[id]`; and/or surface prospects in the Clients/Leads
list with a distinct badge; and/or route the prospect dashboard under `/leads/[id]`.
Small UI change; no migration.

---

## 5. Parked items (agreed, not started)

- **Contractor-vs-admin auth check before Tara gets prod access.** Confirm the whole
  prospect tool path is correctly gated (admin-only where intended; contractors scoped
  to Track-1 grant work per `app/(app)/layout.tsx`). Audit the new routes
  (`/api/clients/drain-match-queue` is admin-session gated; the cron is Bearer) and the
  client dashboard visibility before Tara uses it in prod.
- **Narrative backfill for the ~22 starved clients.** Clients missing
  `client_profile`/narrative get Phase-1 fallback narrative on cards. Backfill via the
  enrichment path so their cards are profile-grounded.
- **Match-quality re-test with a full profile.** Once a client has a complete
  `client_profile`, re-run and eyeball card quality (why-this-org/concept/draft email)
  to confirm `enrichMatchWithProfile` lifts narrative without touching occupancy.

---

## 6. How to verify (preview, since crons are prod-only)

- **Drain on preview:** ensure a prospect is `initial_match_status='queued'` (reset SQL:
  `update clients set initial_match_status='queued' where id='<id>';`), then GET
  `/api/clients/drain-match-queue` while logged in as admin. Expect a JSON summary
  (`budgetExhausted`, `completed`, `advanced`, `queueEmpty`) — currently 504s (§4).
- **Dashboard:** `/clients/[id]` shows "scored X of Y grants" + spinner while
  queued/running; the Grant-activity chart is suppressed until `complete`; `AutoRefresh`
  polls. `initial_match_status` lifecycle: `null → queued → running → complete | error`.
- **Seat-stability harness (mandatory after ANY scorer change):**
  `GET /api/grants/[id]/seat-stability` (admin). Calibration set: Arisa S0_3/2, Harbor
  House NONE/0, NWA Council stable-2, a genuine prime at 3. Exercises `matchGrantToClient`
  directly — the queue work did not touch it, so results must be unchanged.

## 7. File map (quick reference)

- Drain/queue: `lib/clients/match-queue.ts`; routes `app/api/cron/client-match/route.ts`,
  `app/api/clients/drain-match-queue/route.ts`; grant analog `lib/grants/queue.ts`,
  `/api/cron/match`, `/api/grants/drain-match-queue`; watchdog `lib/grants/watchdog.ts`.
- Scorer: `lib/grants/pipeline.ts` (`runMatching`, `scoreGrantClientPair`, `runPipeline`),
  `lib/grants/engine.ts` (`matchGrantToClient`, `enrichMatchWithProfile`, `jsPreFilter`,
  `buildSeatMenu`).
- Create/edit + trigger: `app/(app)/clients/actions.ts`, `client-form.tsx`,
  `new/page.tsx`, `[id]/edit/page.tsx`.
- Dashboard: `app/(app)/clients/[id]/page.tsx`; list `app/(app)/clients/page.tsx`;
  Pipeline `app/(app)/leads/`.
- Types: `types/database.ts` (`Client.initial_match_status`, `Grant`, `ExtractedGrant`).
- Migration: `supabase/migrations/0045_clients_initial_match_status.sql` (applied).
- Cron config: `vercel.json`.
