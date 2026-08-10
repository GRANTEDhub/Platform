# Pursuit / IntellEngine — state audit, 2026-08-10

Fresh audit of what exists on the Pursuit side, read against `d27e4a3` (the #324 merge).
Written down because this scope is not living in chat: the earlier picture in
`matching-pursuit-model.md` §7 was already stale by the time it was re-read, and the
build order below depends on facts rather than recollection.

**Method.** Every file in `app/intellengine`, `components/intellengine`, `lib/intellengine`,
`lib/pursuit`, migration 0062, and every writer of `client_documents`. Persistence claims
were checked by grepping every `fetch`/server-action in the Pursuit tree rather than by
reading comments — several comments were accurate, but they are not evidence.

**Headline.** The flow is a complete, well-built shell with real server-side logic at both
edges and **zero content persistence in the middle**. The only writes in the entire tree are
draft-create, status-advance, delete, and card-routing. Nothing a client types or uploads in
any of the three steps is stored, because `intellengine_drafts` has no columns for it.

---

## 1. What genuinely works

**The client gate.** `lib/pursuit/access.ts` across 13 call sites: five pages
(`requirePursuitVisible` → `notFound`), three API routes (`pursuitApiDenied` → 404), the
portal nav, the dashboard tile, portal search, the grant-detail pursuit option, and the
decision bar. Off unless `PURSUIT_CLIENT_ACCESS_ENABLED === "true"`; staff unaffected. This
is finished work — the switch to flip at the end, not a task.

**Draft lifecycle (the row, not its content).** Create, rename, status-advance-never-backward
(`furthestStatus`), delete. Client-isolated RLS from 0062. Unique index on `card_id` so
re-entering a grant resumes instead of duplicating.

**Delete un-routes the card.** `app/api/intellengine/drafts/[id]/route.ts:86-97` resets
`review_cards.pursuit_path` to null and `decision` to `pending`, returning the grant to the
Grant Report rather than stranding it as "routed to IntellEngine, no draft."

**The eligibility read.** `lib/intellengine/eligibility.ts` — pure, deterministic, no LLM,
computed from the grant's own NOFO fields, rendered as an advisory card. Deliberately never
blocks Continue (the PR #24 lesson: a blunt `hard_disqualifiers` block buried eligible
nonprofits). Real and correct.

**Scope prepopulation.** `lib/intellengine/prepopulate.ts` + `context.ts`. Seeds from the
released concept proposal when the client is entitled (`account_managed` + `sme_released_at`
+ ready), else grant-derived hints, else blank. `context.ts` reads the draft under the
**caller's** RLS as the ownership proof, then service-roles the related grant/client/concept
— the right shape, and the same pattern the portal grant-detail page uses.

**"Ask the experts."** A `mailto:` per section. Works precisely because it has no AI
dependency.

---

## 2. Stubbed or broken — the silent drops

**Status, 2026-08-10.** The scope and build drops are fixed (step 2, PRs #326/#327 — both
editors autosave to `intellengine_drafts.content` and can report a failure). The scope step's
discarding upload control is fixed (3c, #332 — real bucket, real row, click-tested). The two
**compliance** rows below are fixed by the fabrication removal: the six invented documents,
the Verified/Needs-Update tally and the file-discarding `onChange` are all gone, replaced by a
card that states the check is not built and does not block. **The build step's nine hardcoded
mobile-health-clinic sections are still there** — the example text is a placeholder the
builder deliberately does not force-save, but it is the last invented content in the flow.

The table is kept as the record of what was found, not as a live defect list.

| Location | Behaviour |
|---|---|
| `app/intellengine/scope/scope-client.tsx` (whole file) | Nine `useState` hooks, **zero fetch calls**. Scope, role, budget, partners, notes all lost on navigate |
| `scope-client.tsx:93-96` | Uploads keep `f.name` only; the file object is never read. UI still renders a filled file row |
| ~~`app/intellengine/compliance/compliance-client.tsx:21-28`~~ **fixed** | Six **hardcoded** documents with hardcoded dates, identical for every client and every grant |
| ~~`compliance-client.tsx:164`~~ **fixed** | `onChange={() => onVerify(true)}` — discards the file and flips the row to "Verified · Just now" |
| `app/intellengine/build/build-client.tsx:26-98` | Nine hardcoded sections describing **a mobile health clinic**, 2,500 residents, Medicaid reimbursement. Not NOFO-derived; identical for every grant |
| `build-client.tsx:160-167` | **"Save & return to IntellEngine" does not save.** PATCHes `status: complete` only; all nine section texts are discarded |
| `components/intellengine/step-nav.tsx:37-49` | The status PATCH is fire-and-forget — error swallowed, navigation proceeds |

Two are worse than the table conveys:

- **The compliance upload** is the control a client would hand a 990 or an audit to, and it
  affirms receipt of a file it never read.
- **The build "Save"** is the only button in the flow whose *label* promises persistence, and
  it sets `status` to `complete`, which the hub renders as **"Ready to submit"** on a draft
  holding nothing.

**Copy has been made honest since the earlier audit; behaviour has not.** Compliance now
says "an example … not yet a real check" (`:71-74`) and build says "AI assistance is coming
soon … a template you can edit." The *claims* are fixed. "Template" is also honest about
provenance while the content remains one fictional health project — a county road-safety
pursuit opens with a mobile-clinic narrative.

---

## 3. Not built at all

**Any content persistence.** `intellengine_drafts` is `id, client_id, card_id, title,
status, created_at, updated_at`. Full stop. This is the foundation everything else waits on.

**A client-reachable document repository.** Less built than `compliance-client.tsx:19`
implies:

- `client_documents` (0030) exists but is **admin-only RLS** (`is_admin()`), never widened —
  0066 explicitly kept it that way.
- The **only** writer in the codebase is contract signing
  (`lib/contracts/deliver.ts:64-69`), inserting `kind: 'signed_contract'`.
- **No upload UI exists anywhere**, staff or client. `components/clients/client-repository.tsx`
  is display-only (signed URLs), internal-admin only.
- `lib/storage.ts` is `uploadPdf(bucket, path, Buffer)` — server-side, PDF-oriented, with
  only a `contracts` bucket constant.

So the document layer needs a bucket, a client-facing upload path, an RLS change so a client
member can see their own org's documents, and a `kind` taxonomy. Migration plus real work,
not wiring.

**NOFO-derived document requirements.** Nothing reads a NOFO to determine which documents a
grant requires. The six-document list is invented.

**All AI drafting.** No LLM call exists anywhere in the Pursuit tree — there is no
`lib/intellengine/generate.ts` counterpart to `allowable-uses.ts` or `brief.ts`. Section
generation, "Edit with GrantBot" (chat thread), "Regenerate" (with tone options), and
template switching are four `setNote("coming soon")` calls.

**Anything past `complete`.** No export, no assembled document, no submission handoff, no
staff review of a client's draft.

---

## 4. The status-semantics trap

`status` currently means **"furthest screen reached"** — it is advanced by clicking
Continue, and `complete` is reachable today by clicking through three screens without typing
anything.

The moment content persists, `status` has to mean **"this step is actually done."** If
content lands without revisiting this, the hub will say "Ready to submit" about empty
drafts, which is the same class of lie the client gate was put up to stop.

This is baked into step 1 of the build order below rather than deferred, because it is
cheapest to fix before anything writes content and impossible to fix quietly afterwards.

A second instance of the same trap, worth naming now: if stored content is prefilled with
the template text, "every section non-empty" becomes true the moment a draft is created, and
completeness is a lie again. Stored content must never contain template text — templates are
UI placeholders only, so "non-empty" means "a human or the model actually wrote this" by
construction.

---

## 5. Build order (confirmed 2026-08-10)

Strict dependencies. One brick at a time, each scoped, approved, built, and verified before
the next.

1. **Content-persistence schema** on `intellengine_drafts`, with the corrected status
   semantics from §4. The foundation; everything waits on it.
2. **Scope + build save** wired to that schema.
3. **Document layer** — bucket, client upload path, RLS, `kind` taxonomy. The larger
   parallel track.
4. **NOFO-derived document requirements**, replacing the invented six-document list.
5. **AI drafting** — the actual LLM generation, plus GrantBot and Regenerate.
6. **Past-complete** — export, assembly, submission handoff, staff review of client drafts.

The client gate (`PURSUIT_CLIENT_ACCESS_ENABLED`) flips only after the silent drops in §2
are gone, which is the end of step 2 for scope/build and the end of step 3 for documents.

Eligibility (§1) and prepopulation (§1) are done and block nothing.

**Progress.** Steps 1 and 2 are merged and verified in production (0074 applied; the
network-kill, clear-and-return and persistence checks all pass against `app.grantedco.com`).
Step 3 is in progress: **3a, 3b and 3c merged** (0075 and 0076 applied). The gate is still off.

### ⚠ Outstanding: the document layer has never been exercised by a real click

**Blocking precondition on un-gating.** 3b and 3c are merged on automated coverage only. Both
the 3b curl run and the 3c click-test were **skipped by decision**, so as of 2026-08-10 no
human has uploaded, opened or deleted a file through this layer — not on prod, not on a
preview. What that leaves unproven, precisely:

| Covered today | Not covered until someone clicks |
|---|---|
| `verify` green; `tsc` + `next build` clean | mint → PUT → confirm actually completing against real storage |
| Predicate mirrors for `canWrite` / `canDelete` / `canReadDocument`, including the contract and contractor cases | the signed **upload** URL working end to end from a browser |
| Three privilege escalations found and fixed pre-merge (#330, #331) | the signed **download** URL opening real bytes |
| Row-after-object ordering, by construction | delete removing both row and object |

The distinction that matters: the checks above prove the *logic* is right. Nothing yet proves
the *plumbing* works — a signed-URL upload has several moving parts (token, endpoint shape,
body encoding, bucket mime/size limits) that no unit-level test in this repo touches.

**So: a real upload / open / delete click-test must happen before `PURSUIT_CLIENT_ACCESS_ENABLED`
is ever turned on.** Not a blocker while the gate is off — no client can reach any of it — but
it is not optional before un-gating, and it is written here rather than left in a chat log
because "3b/3c merged" reads like "3b/3c verified" and it is not the same claim.

A separate gap, and it needs a **client** login rather than a staff one: an admin reads
`client_documents` through 0030's `is_admin()` policy, so a staff click-test would still not
exercise 0075's `is_client_member_of(client_id) and client_visible` — the predicate that keeps
signed contracts away from clients. Covered by the predicate mirror only. The click-test should
therefore be run as a real client member once the gate allows it.

### 5.1 Step 3 sub-sequence (approved 2026-08-10)

Step 3 is the largest brick, so it is split into four. Same rhythm as 1 and 2: each is
scoped, approved, built, verified.

Three decisions settled before the split, because they set the boundaries:

- **Transport is a SIGNED UPLOAD URL**, minted server-side. Posting the file through a route
  is ruled out by Vercel's ~4.5MB serverless body limit, which 990s and audits exceed;
  direct-to-storage with `storage.objects` RLS would need a policy parsing `client_id` out of
  an object path, and would break the house pattern where the `contracts` bucket carries no
  authenticated policy at all. A minted URL keeps the membership check server-side, needs no
  storage RLS, and has no body limit.
- **The member RLS grant is SELECT-only and must not expose `signed_contract`.**
  `client_documents` holds signed contracts under the financial-firewall pattern (0030
  admin-only; 0066 explicitly kept it). A blanket member policy would hand every client their
  own contract row. Members never write the table -- the route does, service-role -- so
  SELECT is the whole grant needed.
- **Org documents and pursuit files share one repository**, separated by a nullable
  `intellengine_draft_id`: null = org-level (staff-owned), set = a draft's own file
  (the client's to remove).

1. **3a — Foundation.** Private bucket with its size and mime limits set ON THE BUCKET, the
   two new `client_documents` columns, the member SELECT policy, generalised storage helpers.
   No routes, no UI, nothing a client can see.
2. **3b — Server upload path.** Mint → client PUTs → confirm-and-insert, plus delete. Two
   calls on purpose: a row must not exist unless its object does, or the looks-received lie
   moves from the UI into the database. Verifiable by curl before any UI exists.
3. **3c — Scope step: real supporting files.** Keeps the promise made when the discarding
   upload control was pulled out in step 2. At this point the scope step is fully honest.
   Settled while building it:
   - **A signed-download route ships with it** (`GET /api/client-documents/[id]/url`). A file
     you cannot open is a claim you cannot check, which is the same defect one step removed.
     `canReadDocument` is the third predicate, and it mirrors 0075's member policy exactly:
     membership **and** `client_visible`. Membership alone would hand a client a signed URL to
     their own signed contract while the RLS-backed list correctly refused to show it.
   - **Read is the one place the org-level asymmetry reverses.** Writes and deletes are
     staff-only at org level; reads are not, because a staffer files a client's 990 *for the
     client*. So `canReadDocument` has no `intellengine_draft_id` branch — deliberately, not by
     omission.
   - **No GET list route.** The initial list is server-rendered under the caller's RLS, then
     maintained from the confirm and delete responses. A row appears because the server
     returned one, never because the browser assumed one.
   - **Uploads do NOT count toward completeness, and `content.ts` stays unaware documents
     exist.** Supporting files are optional; letting an optional artifact satisfy a required
     step is the conflation step 1 removed.
   - **Uploads are a second persistence path the autosave cannot see**, so Continue checks an
     in-flight upload independently of `flush()` and refuses to navigate. Same anti-silent-drop
     rule as step 2, reached by a different route.
4. ~~**3d — Compliance step: real org documents.**~~ **SUPERSEDED 2026-08-10, do not build.**
   The plan was a client-facing list of org-level documents with upload/replace. Two things
   killed it. First, a survey of every writer of `client_documents` found the org-level set a
   client can see is **empty for every client**: the only writer is contract signing
   (`lib/contracts/deliver.ts`), and it leaves `client_visible` at its 0075 default of false.
   Second, and decisive, the product model changed: documents are for **assimilation**, not
   filing. A browsable client-facing repository is the wrong artifact.

   **The replacement — document assimilation.** Upload → extract a structured summary (type,
   title, synopsis, document date, matching/drafting facts, plus a human-fillable note) →
   a human reviews proposed profile changes → commit. The extracted text is what feeds the
   client profile; the raw file is **retained internally so extraction can be re-run against
   the source**, never surfaced as a repository. `client_visible` stays false, which is also
   what keeps the decision reversible: surfacing later is flipping a boolean and adding a read
   route, not a migration.

   Settled with it:
   - **Both clients and staff may commit** — no approval bottleneck — but every commit logs
     who, when, which document, and **before/after per field**, so a change can be audited and
     rolled back by re-applying the "before" values.
   - **Asymmetric review default.** A proposed value for an EMPTY profile field is pre-checked;
     one that would OVERWRITE existing content is unchecked and shown side by side. Filling a
     gap is cheap; overwriting a human's words takes a deliberate click. Extends the
     additive-only guard `confirmClientProfileAction` already applies to `primary_funding_needs`
     and `org_type`.
   - **An extracted document date is a claim, not a fact** — labelled extracted-not-confirmed
     until a human accepts it, the same rule award amounts follow.
   - **3a/3b are reused** (bucket, columns, mint → PUT → confirm; the row-after-object ordering
     matters more here, since a row with no object can never be re-extracted). **3c stays as
     it is** — pursuit attachments for one application are working materials, not an org
     document shelf. One fix falls out: 3b's confirm route hardcodes `client_visible: true`,
     which is the wrong default for a retained-not-surfaced raw file.
   - **Build order: plumbing before prompt.** Fabrication removal, then the `client_visible`
     fix, then schema + audit + review/commit against a stub extractor, then the real
     extraction prompt. LLM calls cannot run from the sandbox, so extraction QUALITY is a
     production check on real documents — which is the argument for making a wrong extraction
     land as a rejected field rather than a corrupted profile before the shredder exists.

   Compliance completeness stays `unknown` throughout, and the reason is now more durable than
   "the list is hardcoded": knowing which documents a client holds is still not knowing whether
   they satisfy **this** program. That is step 4.

Un-gating is a judgment call, not an automatic consequence of finishing the document layer: the
compliance step is honest but thin until step 4 supplies real per-grant requirements, and it now
says so on the page rather than showing an invented tally.

The click-test precondition recorded under §5's progress note is **partly discharged**: 3c was
exercised end to end on 2026-08-10 (upload and open confirmed against real storage in the
NWACC / Test Client walkthrough), which also exercised 3b's mint → PUT → confirm. What has still
never been exercised by a real client login is 0075's member policy —
`is_client_member_of(client_id) and client_visible` — because the walkthrough ran as staff, who
read through 0030's `is_admin()` instead. That predicate is covered by tests only.

Settled alongside the sequence:

- Clients may delete their own **draft-level** uploads. Org-level documents are **staff-owned
  firm records** and are not client-deletable.
- Staff-console visibility of client uploads is a **follow-on touch**, deliberately not in 3b.
- An object uploaded but never confirmed is left as an invisible orphan. A sweeper cron is
  out of scope for this brick; recorded here rather than fixed.
