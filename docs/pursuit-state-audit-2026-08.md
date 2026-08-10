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

| Location | Behaviour |
|---|---|
| `app/intellengine/scope/scope-client.tsx` (whole file) | Nine `useState` hooks, **zero fetch calls**. Scope, role, budget, partners, notes all lost on navigate |
| `scope-client.tsx:93-96` | Uploads keep `f.name` only; the file object is never read. UI still renders a filled file row |
| `app/intellengine/compliance/compliance-client.tsx:21-28` | Six **hardcoded** documents with hardcoded dates, identical for every client and every grant |
| `compliance-client.tsx:164` | `onChange={() => onVerify(true)}` — discards the file and flips the row to "Verified · Just now" |
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
