# Matching / Pursuit — platform flow model, audit, and build order

Durable record of the two-pipeline model, the codebase audit behind it, and the agreed
build order. Written down because this was worked out in conversation and fell out of
context once already; a scoped decision that only exists in a thread is a decision that
can be lost.

**Status of this document:** the audit findings and the two structural decisions
(§3, §4) are settled. The build order in §5 is the operative plan, with one item
never explicitly signed off — flagged inline. Actionable to-dos still belong in
GitHub issues; this file holds the model and the reasoning.

---

## 1. The two pipelines

The platform is two sequential pipelines, not one funnel.

| | **Grant Matching** | **Grant Pursuit** |
|---|---|---|
| Flow | Alert → Grant Report | concept editing → readiness gate → drafting |
| Exists today | ~70% — production-real | ~30% — navigation and seeding only |
| Missing | polish, client-facing surfacing | persistence, AI |

**The averaged "~70% already exists" is misleading and should not be quoted.** It is
about right for Matching. Pursuit is nearer 30%: the navigation and seeding exist, the
persistence and the AI do not. The average hides the split, and Pursuit is the half the
premium tier sells.

**Vocabulary only.** "Matching" and "Pursuit" are adopted in copy and docs. They are
*not* schema identifiers — see §3.

---

## 2. Codebase audit — the document layer

The fork was whether the document layer is (a) a currency/expiry-tracking layer over
document storage that already works, or (b) the storage itself.

**It is (b). There is no upload path for anyone — not clients, not staff.**

Verified against the tree (anchors re-checked at time of writing):

- **The only writer of `client_documents` is `lib/contracts/deliver.ts`**, inserting
  `kind: 'signed_contract'` — a PDF we generate ourselves. `clients/[id]/edit` only
  *reads* it (staff download list).
- **The two file inputs in IntellEngine are theatre, and their own comments say so:**
  - `app/intellengine/compliance/compliance-client.tsx:164` —
    `onChange={() => onVerify(true)}`. The file is discarded; it flips local state so the
    row turns green. Comment: *"selecting a file just simulates the document being
    re-verified."*
  - `app/intellengine/scope/scope-client.tsx:329-338` — *"only the filename is kept."*
- **RLS is `is_admin()` only.**
- **Buckets in existence are `contracts` and `grant-alerts`. There is no `documents`
  bucket** (`lib/storage.ts` defines `CONTRACTS_BUCKET` only).
- **`created_by` references `profiles`**, so the schema cannot even attribute a client
  upload.

So this is not a metadata layer over working storage. It is the feature.

### What it actually takes

1. A private `documents` bucket + path convention. `lib/storage.ts` is reusable as-is —
   `uploadPdf` / `downloadPdf` / `signedUrl` / `removeObjects` all exist and work.
2. An upload route: multipart handling, type/size validation, and a decision on
   file-content sniffing. **This is the first user-supplied binary in the product, which
   makes it the highest-risk surface in the platform.**
3. Schema: a `kind` taxonomy with a `CHECK`, `period_covered` / `valid_from` /
   `expires_at`, `superseded_by` for re-uploads, and an **actor column** — same problem
   as the concept editor, since `created_by → profiles` cannot hold a client member.
4. **Per-kind currency rules, not one TTL** — audit annually, 990 by fiscal year, board
   list on change. A rules map.
5. Client RLS + a guard trigger on the 0055/0056/0070 pattern, so a member reaches only
   their own org's documents and cannot touch staff fields.
6. Two UIs: client upload, and staff upload/override.

**Reusable:** the storage helpers, the table's shape, the staff download list, and the
isolation patterns to copy. Everything else is new.

**This is the largest single item in the model** — several migrations, a new bucket, an
actor model, and client-writable storage.

---

## 3. Decision: do NOT rename the stages

Renaming stage identifiers to match Matching/Pursuit vocabulary was dropped, deliberately.

Stage identifiers are load-bearing across `decision`, `pursuit_path`, `pipeline_stage`,
the `STAGE` / `STAGE_PORTAL` palettes, `rollUpPortal`, the bell predicate, `CHECK`
constraints, and the `guard_card_approval` trigger's column allowlist — the fail-closed
jsonb diff that enforces client isolation.

Renaming means production migrations against the isolation boundary, for **zero
client-visible change**, before real usage has validated the model. That is the
highest-risk, lowest-value way to start.

**Adopt Matching/Pursuit as vocabulary in copy and docs; leave the identifiers alone.**
The schema already encodes the boundary — it does not need to say "pursuit" to be true.

---

## 4. Decision: SME button before Allowable-Uses extraction

The original instinct was extraction first, with the Request-SME button as a small
add-on. That is inverted: **the button is the product and the extraction is the
follow-on.**

- The SME button alone answers *"can it fund X?"* with a human — full accuracy, zero AI
  risk, no extraction at all.
- The static allowable-uses list is an *optimization* that reduces SME load.
- Building the button first means **every question gets logged** — and that log is the
  spec for which allowable-uses cases are worth extracting, plus the v2 GrantBot
  calibration set.

This is the same argument already accepted for deferring GrantBot, applied one level
down.

---

## 5. Build order

1. **`before_you_approve` client-facing on the alert + Grant Report.** Cheapest thing in
   the model — the field is already populated and there are three staff renderers to
   copy. *Caveat:* it was written in staff voice. Read a dozen real values before
   shipping them to clients.

2. **Request SME — question-scoped and logged.** Small table (`client_id`, `card_id`,
   question text, status, `answered_by` / `answered_at`), notification to Shannon,
   monetization hook. Answers the top client question immediately.
   *(This is the one item never explicitly signed off — see §6.)*

3. **Allowable Uses.** Extraction on the 0002 pattern + a backfill sweep (the
   `grant-briefs` cron is the template, and it now carries requeue and attempt-cap
   machinery). Display with provenance — NOFO quote + section — so any line is
   checkable. Spec'd from the questions logged in step 2.
   **Blocked on one fact:** `select count(*) from grants where raw_text is null`. If
   coverage is patchy this degrades unevenly and clients will notice. Requires row-level
   SELECT, which the sandbox does not have.

4. **Readiness — split in two.** The registration/finance half is real *today* from
   clients (`sam_expiration_date`, `nonprofit_finance`, `ein`/`uei`, `annual_budget`).
   Ship that at Report time: it is client-level, so it catches dealbreakers before
   commitment. **The document half waits** for step 5.

5. **Document layer** (§2 — the big one). Also the prerequisite for the Pursuit
   readiness gate.

6. **Pipeline 2 persistence — before any more Pursuit UI.**

---

## 6. Open items

- **Step 2's inversion (§4) was proposed and never explicitly confirmed.** The build
  order above treats it as operative. One word settles it.
- **Live-risk check — RESOLVED, and the answer is the bad one. See §7.**
- The "hold pending Sam's read" that gated this build order is **stale** — superseded.

---

## 7. The Pursuit screens ARE client-reachable in production

Confirmed against the tree. There is no feature flag anywhere in the path.

**Three entry points, all client-facing:**

- `components/layout/portal-header.tsx:26` — **`{ href: "/intellengine", label: "IntellEngine" }`
  is a permanent tab in the client portal nav**, sitting beside Dashboard, Grant Alerts,
  and Grant Report. The file's own comment argues it belongs in the nav rather than only
  on a dashboard tile.
- `app/portal/page.tsx:274` — `intellEngineHref="/intellengine"` on the client dashboard.
- `components/report/pursuit-chooser.tsx:178,184` — the Grant Report's pursuit chooser
  `router.push`es clients straight in.

**The guards admit clients by design.** `/intellengine` and `/intellengine/[draftId]` use
`requireClient()`; `scope`, `compliance`, and `build` use `requireClientOrAdmin()`
(`lib/auth.ts:129`), which returns early for staff and otherwise passes any activated
`client_members` row. The layout is deliberately ungated — `0656605` moved the check to
the pages on purpose. From the hub, `resumeStep(status)` routes a draft to
`scope` / `compliance` / `build` (`components/intellengine/hub.tsx:62`).

**What a client finds there:**

- `app/intellengine/scope/scope-client.tsx` — **zero `fetch`/POST calls.** Editor state is
  purely local. Its header comment: *"persisting these edits back to the draft is the
  remaining follow-up… Uploaded files keep only the filename; nothing is stored yet."*
- `app/intellengine/compliance/compliance-client.tsx:164` — `onChange={() => onVerify(true)}`.
  `markVerified` is local state with no network call. **The row turns green**, which is an
  affirmative claim that a compliance document was received and verified, about documents
  like a 990 or an audit.
- `intellengine_drafts` (migration 0062) stores only `status`
  (`scope`/`compliance`/`build`/`complete`) — structural progress, no content.

So a client can type a full project scope, upload their audit, watch the row go green,
navigate away, and lose all of it — having been told the opposite.

**Not verifiable from the sandbox:** whether any client has actually done this. That needs
row-level SELECT. Code-path reachability is certain; usage is not known.
