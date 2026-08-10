# Matching / Pursuit — platform flow model, audit, and build order

Durable record of the two-pipeline model, the codebase audit behind it, and the agreed
build order. Written down because this was worked out in conversation and fell out of
context once already; a scoped decision that only exists in a thread is a decision that
can be lost.

**Status of this document:** refreshed against `main` on 2026-08-10, after PRs #338–#344
and migrations 0072–0079. The two structural decisions (§3, §4) are settled and unchanged.
§2's audit and §7's live-risk finding are **historical** — both were true when written and
have since been superseded by shipped work; they are kept, marked, and followed by what
actually landed, because the reasoning still explains why the layer is shaped as it is.
§5 now carries one canonical numbering and a status column. Actionable to-dos still belong
in GitHub issues; this file holds the model and the reasoning. Sequencing across programs
lives in `docs/roadmap-2026-08.md`.

---

## 1. The two pipelines

The platform is two sequential pipelines, not one funnel.

| | **Grant Matching** | **Grant Pursuit** |
|---|---|---|
| Flow | Alert → Grant Report | concept editing → readiness gate → drafting |
| Exists today | ~70% — production-real | navigation, persistence, and the document layer; no AI, no submission |
| Missing | polish, client-facing surfacing | flow steps 4, 5, 6 (see §5) |

**Do not quote an averaged "~70% already exists."** It is about right for Matching only.
Pursuit was ~30% when this document was written — "navigation and seeding only." That is
no longer accurate: persistence shipped (0074) and the document layer shipped (0075–0079).
What is genuinely absent is now specific and nameable — requirements, drafting, submission —
which is more useful than a percentage.

**Vocabulary only.** "Matching" and "Pursuit" are adopted in copy and docs. They are
*not* schema identifiers — see §3.

---

## 2. Codebase audit — the document layer

> **HISTORICAL — SUPERSEDED BY SHIPPED WORK (0075–0079, #338–#343).** The finding below was
> true when written and is the reason the layer exists at all. What shipped, and what
> deliberately did not, is in §2b. Read this part for *why*, not for *state*.

The fork was whether the document layer is (a) a currency/expiry-tracking layer over
document storage that already works, or (b) the storage itself.

**It is (b). There is no upload path for anyone — not clients, not staff.**

Verified against the tree at the time:

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
  bucket.**
- **`created_by` references `profiles`**, so the schema cannot even attribute a client
  upload.

So this is not a metadata layer over working storage. It is the feature.

### What it was estimated to take

1. A private bucket + path convention.
2. An upload route: multipart handling, type/size validation, a decision on
   file-content sniffing. **The first user-supplied binary in the product, which makes it
   the highest-risk surface in the platform.**
3. Schema: a `kind` taxonomy with a `CHECK`, `period_covered` / `valid_from` /
   `expires_at`, `superseded_by` for re-uploads, and an **actor column**.
4. **Per-kind currency rules, not one TTL** — audit annually, 990 by fiscal year, board
   list on change. A rules map.
5. Client RLS + a guard trigger on the 0055/0056/0070 pattern.
6. Two UIs: client upload, and staff upload/override.

**This is the largest single item in the model.**

---

## 2b. What actually shipped, and what did not

The layer landed across seven PRs. Item numbers below map to §2's estimate, because the
divergences are the interesting part.

**Shipped:**

- **(1) Bucket + path convention** — `client-uploads`, private, size and MIME limits set
  **on the bucket** (`lib/storage.ts`, 0075). Named for what it holds, not `documents`.
  Path is `clientId/{org|draft-<id>}/<uuid>-<sanitised name>`, client id first so a
  client's objects are removable by prefix.
- **(2) Upload transport — NOT a multipart route.** `mint → PUT → confirm`: the server
  authorises and mints a signed upload URL, the browser PUTs straight to storage, then a
  confirm route reads the object's **real** size and content type back from storage and
  writes the row from that rather than from the client's claim. This dodges the ~4.5MB
  serverless body limit (a scanned 990 exceeds it routinely) and means our code never
  handles the bytes on the way in. One implementation of the dance, shared by both
  surfaces (`components/documents/use-document-upload.ts`, #341) — a copied
  three-call authorisation sequence is one that drifts.
- **(3, partial) Schema + actor model.** `kind` taxonomy in `lib/documents/kinds.ts`,
  `client_visible` (0075, defaulting **false**), `intellengine_draft_id` as the
  org-vs-draft discriminator, unique-object constraint (0076). The actor problem is solved
  in code rather than by a column: `resolveDocumentActor` returns a `DocumentActor`
  (staff/admin flags plus the caller's `clientIds`), and `canRead/canWrite/canDelete`
  mirror the RLS policies rather than restating them loosely.
- **(5) Client RLS** — member SELECT gated on `client_visible` (0075); 0077 moved staff
  grant work from `is_admin()` to `is_staff()` with an org-vs-draft split, so a contractor
  reaches draft-level documents and never the org shelf where signed contracts live.
- **(6) Two UIs** — staff console panel (`app/(app)/clients/[id]/documents/upload-panel.tsx`)
  and a client-facing list inside the Pursuit scope step
  (`components/documents/upload-list.tsx`). **See the caveat below.**
- **Assimilation, which §2 did not anticipate** (0078–0079, #340/#342/#343): extraction →
  field-level review → commit → append-only audit → rollback. A document can propose
  changes only to fields a client could already type by hand (`PROPOSABLE_FIELDS`); `ein`
  and `annual_budget` are deliberately excluded. `client_profile_changes` has SELECT
  policies and **no** INSERT/UPDATE/DELETE policy, which is what makes it an audit trail;
  `document_id` is `ON DELETE SET NULL` so deleting a document cannot rewrite what it
  changed. The real extractor (one Sonnet call, shape-validated, nothing pre-ticked)
  shipped in #343.

**Did NOT ship, and is still open:**

- **(3, rest) and (4) — currency tracking.** There are no `period_covered`, `valid_from`,
  `expires_at`, or `superseded_by` columns anywhere in 0075–0079, and no per-kind rules
  map. **The layer shipped as storage + assimilation, not as the currency layer §2
  described.** Anything that wants "is this 990 current?" is building it from scratch.
- **Raw document text is not persisted.** Extraction parses the PDF/DOCX in memory, stores
  a synopsis plus proposed profile fields, and discards the text.
  `ClientProfileInput.documents` (`lib/clients/profile.ts`) is declared for it and is fed
  by nothing. Any feature wanting document *contents* — GrantBot included — must choose:
  synopsis-only, re-parse on demand, or persist text (which means holding client financials
  as searchable text).

**Caveat on (6):** the client-facing upload list is mounted only inside
`app/intellengine/scope`, which sits behind `PURSUIT_CLIENT_ACCESS_ENABLED` (§7). With the
flag off — its current state — **no client can reach an upload control**, and there is no
document surface in the portal proper. In practice today, uploads are staff-filed. Un-gating
Pursuit therefore also un-gates client upload, which is a coupling worth stating out loud
before the flag flips.

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
  spec for which allowable-uses cases are worth extracting, plus the GrantBot
  calibration set.

**Note on what happened next:** allowable-uses extraction shipped first anyway (0072, a
cron, client-facing display) and the SME button did not get built. The decision above was
not reversed — it was overtaken. Its argument still stands and is now the only
ground-truth eval set available for any LLM output in this platform (see
`docs/roadmap-2026-08.md`).

---

## 5. Flow steps and work items — one numbering, with state

There were two competing numbering schemes: this section's original 1–6 work list, and the
**flow-step** numbers the code comments reference (`compliance-client.tsx` — *"step 4's
job"*; `build-client.tsx` — *"step 5 of the build order"*, *"submission is step 6"*). They
did not line up, which made the doc unusable next to the code.

**The flow-step numbering is canonical.** It is what the code says, it survives work items
being reordered, and it is what "steps 4–6 are unbuilt" means in every conversation about
this pipeline. The old work list is preserved below as work items with status — it is a
priority list, not a numbering scheme, and should never be cited as "step N".

### 5a. Flow steps (canonical)

| Step | What it is | State |
|---|---|---|
| 1 — Scope | Project scope editor | **Shipped.** Autosaves to `intellengine_drafts.content.scope` (0074) |
| 2.5 — Eligibility | Per-client eligibility read, computed server-side from the grant's own NOFO fields | **Shipped** (#338). The fabricated document tally was removed and the gap is stated on the screen |
| 3 — Build | Nine NOFO-shaped proposal sections | **Shipped** (0074). Sections autosave; `draftCompleteness` derives readiness from stored content. Of its three actions, only "Ask the experts" is real — "Edit with GrantBot" and "Regenerate" wait on step 5 |
| 3a–3d — Document layer | Bucket, upload, visibility, list/delete | **Shipped** (0075–0077, #339–#341). See §2b |
| (i)–(iv) — Assimilation | Extraction → review → commit → audit → rollback | **Shipped** (0078–0079, #340/#342/#343) |
| **4 — Requirements** | NOFO → what *this grant* requires | **Not built.** The denominator 2.5 deliberately lacks |
| **5 — AI drafting** | LLM plumbing in the build step ("Edit with GrantBot", "Regenerate") | **Not built** |
| **6 — Submission / export** | Assemble and submit | **Not built.** Per-funder formats, Grants.gov workspace, document assembly — the least certain of the three |

Pursuit stays gated off clients (`PURSUIT_CLIENT_ACCESS_ENABLED`) until 4–6 land.

### 5b. Work items, in the priority order agreed — with status

1. **`before_you_approve` client-facing on the alert + Grant Report.** **Not built.** Still
   the cheapest client-facing win in the model: the field is already populated and there are
   three staff renderers to copy (`review/[id]`, `clients/[id]/roadmap`, `check-grant`).
   Verified absent from `app/portal`, `lib/alerts`, and `components/report`.
   *Caveat that has not gone away:* it was written in staff voice. Read a dozen real values
   before shipping them to clients.

2. **Request SME — question-scoped and logged.** **Not built**, and never explicitly signed
   off (§6). Small table (`client_id`, `card_id`, question text, status, `answered_by` /
   `answered_at`), notification to Shannon, monetization hook. Doubles as the eval set for
   every LLM surface, which is now its strongest argument.

3. **Allowable Uses.** **Shipped**, and further than planned: extraction (0072), a cron
   (`app/api/cron/allowable-uses`), and **client-facing display** on
   `app/portal/grants/[id]` with provenance.
   *The blocking fact was never resolved:* `select count(*) from grants where raw_text is
   null` still requires row-level SELECT, which the sandbox does not have. Coverage is
   therefore unmeasured from here.

4. **Readiness — split in two.** **Not built.** The registration/finance half is real
   *today* from clients (`sam_expiration_date`, `nonprofit_finance`, `ein`/`uei`,
   `annual_budget`) and can ship at Report time. The document half is now *possible* —
   assimilation supplies what the org has — but still needs **flow step 4** for what the
   grant needs. Two halves of a join.

5. **Document layer.** **Shipped as storage + assimilation; currency tracking did not
   ship.** See §2b.

6. **Pipeline 2 persistence.** **Shipped** (0074). Scope and section drafts persist;
   completeness is derived from content rather than a status flag.

---

## 6. Open items

- **§4's inversion was proposed and never explicitly confirmed**, and events overtook it
  (see the note in §4). Request SME remains unbuilt. One word still settles whether it is
  next.
- **Live-risk check — RESOLVED. See §7.**
- The "hold pending Sam's read" that gated this build order is **stale** — superseded.
- **Currency/expiry tracking has no owner.** It was item 4 of §2's estimate, it did not
  ship with the layer, and nothing in the flow steps covers it. It is not blocking anything
  today; it is unowned rather than done.

---

## 7. The Pursuit screens were client-reachable in production — RESOLVED

> **RESOLVED.** Fixed by the flag in `lib/pursuit/access.ts` plus #338 (the fabricated
> compliance check removed) and 0074 (persistence). The finding is kept in full because it
> is the reason the flag exists, and because the class of defect — *a screen asserting
> something it cannot deliver* — is the one this codebase keeps producing.

**What was true.** There was no feature flag anywhere in the path. Three client-facing
entry points led into the Pursuit screens: the permanent `IntellEngine` tab in the portal
nav, the client dashboard tile, and the Grant Report's pursuit chooser. `scope`,
`compliance`, and `build` used `requireClientOrAdmin()`, which passes any activated
`client_members` row.

**What a client found there.** `scope-client.tsx` made zero `fetch`/POST calls — editor
state was purely local. `compliance-client.tsx:164` was `onChange={() => onVerify(true)}`:
the row turned green, which is an affirmative claim that a compliance document had been
received and verified, about documents like a 990 or an audit.
`intellengine_drafts` (0062) stored only `status`. So a client could type a full project
scope, upload their audit, watch the row go green, navigate away, and lose all of it —
having been told the opposite.

**How it stands now.**

- `pursuitClientAccessEnabled()` gates client access, **off by default** and requiring the
  literal string `"true"`. `requirePursuitVisible()` guards the pages (`notFound()`, not a
  redirect — a redirect advertises that the route exists) and `pursuitApiDenied()` guards
  the routes, because hiding a button does not close the endpoint behind it. Staff are
  unaffected by design: they drive the same wizard from the console.
- The fabricated compliance panel is gone (#338). Nothing replaced the tally, deliberately —
  a count needs a denominator and the denominator is flow step 4.
- Scope and section content persist (0074).

**Still not verifiable from the sandbox:** whether any client lost work before the flag
landed. That needs row-level SELECT. Code-path reachability was certain; usage was never
known.
