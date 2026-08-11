# Roadmap — August 2026: three build programs and the order to build them

Durable record of a sequencing decision worked out in conversation on 2026-08-10. Written
down for the same reason `docs/matching-pursuit-model.md` exists: a decision that lives only
in a thread is a decision that gets re-litigated from memory.

**Scope of this file:** the three programs, the decision that orders them, and the
constraints that must survive into the build. Per-pipeline mechanics stay in
`docs/matching-pursuit-model.md`. Actionable to-dos are GitHub issues.

**State it was written against:** `main` after #344 (migrations through 0079).

---

## The decision that sets the order

**No signed or near-signed engagement currently expects the Pursuit / IntellEngine side.**

That is the whole reason GrantBot can go before finishing IntellEngine. Pursuit is what the
premium tier sells and it is gated off clients today; ordinarily that argues for finishing it
first. Absent a client waiting on it, the staff-facing force multiplier wins.

**If that changes, the order flips.** A contract that expects Pursuit moves IntellEngine
steps 4–6 back to the front. This is the one external fact the sequencing rests on, so it is
stated first and on its own.

---

## Program 1 — IntellEngine: finish Pursuit

**Shipped:** the document layer (3a–3d), assimilation ((i)–(iv), extraction through audit
and rollback), and Pursuit persistence (0074 — scope and the nine proposal sections both
autosave, completeness derived from content).

**Remaining, in flow-step numbering (`docs/matching-pursuit-model.md` §5a):**

| Step | What | Notes |
|---|---|---|
| 4 | NOFO → requirements | What *this grant* requires. The denominator step 2.5 deliberately lacks. Smallest of the three, and the extraction pattern is now routine — 0072 + cron + provenance is the template, and (iv) proved the pure-validator/prompt split |
| 5 | AI drafting — "Edit with GrantBot", "Regenerate" | Both are already named placeholders in the build step |
| 6 | Submission / export | Per-funder formats, Grants.gov workspace, document assembly |

**Steps 5–6 are the expensive, least-certain parts — 6 especially.** Step 4 is cheap and
unlocks the readiness gate that assimilation was built to feed (assimilation says what the
org *has*; step 4 says what the grant *needs*; readiness is the join).

Pursuit stays gated off clients until 4–6 land. **Note the coupling:** the only
client-facing upload control lives inside the pursuit-gated scope step, so un-gating Pursuit
also un-gates client upload (`docs/matching-pursuit-model.md` §2b).

---

## Program 2 — GrantBot v1: staff-only, paste-driven, per-client colleague

A chat panel on each client's admin page, powered by the existing Anthropic integration,
that works the way a dedicated Claude project per client works today — which is the
operating model this is porting into the platform, not a new idea to validate.

**Seeded with:**
1. The client's live platform state — profile, documents, grants — pulled automatically.
2. A handoff doc, pasted in once.
3. A shared instruction set plus per-client tailoring.

**Then fed by hand.** Email threads and Gemini call notes get pasted in as they happen.
**v1 explicitly does not build in-app messaging or calendar/Gemini capture** — that is
Program 3, and removing it is what makes v1 small.

Working example: open GrantBot on a client's page, say *"picking up from where we left off —
Kim emailed me this [paste], draft a response"*, and it answers with the client's context
already loaded.

**Rough shape — four bricks:**

1. **Conversation store + turn route.** Client-scoped, append-only. System prompt assembled
   server-side. **Non-streaming first** — nothing in the codebase streams today, and adding
   streaming is a separate concern from working.
2. **The panel** on `app/(app)/clients/[id]`.
3. **Context assembler.** Mostly reuse: `resolveIntellEngineContext`
   (`lib/intellengine/context.ts`) and `buildClientProfileInput` (`lib/clients/profile.ts`)
   are two existing assemblers, plus the roadmap's per-client card queries.
4. **Instruction / tailoring / handoff store.**

**What the existing Anthropic integration does and does not give us.** It is not
matching-only: fourteen modules call it today, including concept-proposal generation, alert enrichment,
grant briefs, allowable-uses extraction, outreach drafting, website enrichment,
client-profile distillation, and document extraction. `lib/anthropic.ts` is a client factory
plus model constants. **But every one of those calls is single-shot, tool-forced, and
stateless** — across 79 migrations there is no conversations/messages table, and there is no
streaming anywhere. The head start is the SDK wiring and the prompt idiom; the chat
machinery is new.

**Why it is low-risk:** staff-only admin surface. No client-facing surface, no RLS widening,
no send path, no gate to un-gate.

---

## Program 3 — GrantBot v2: self-updating (later)

The same GrantBot, with capture automated: client comms move into in-app messaging and are
captured as they happen; calls are scheduled via Google Workspace with Gemini notes flowing
back in. Context stays current without pasting.

**v1 does not depend on v2** — v1 works paste-driven and is useful on its own. v2 automates
the capture v1 does by hand.

**Its two dependencies are each their own program, and each is bigger than GrantBot v1:**
in-app messaging (identity, notifications, delivery, retention) and Google Workspace +
Gemini (integration plus a call→client mapping). Both pay off across the product rather than
only for GrantBot, so **sequence them on their own merits, not as GrantBot prerequisites.**

---

## Agreed sequencing

1. **This doc refresh + roadmap commit.** ← now
2. **Brick 0 — the context-pack button.** A "copy context pack" button on the client page
   that assembles everything the platform knows into markdown, for pasting into the existing
   Claude project. Small, reversible, useful the day it ships — and it answers *"what
   context actually helps"* with real data before any chat machinery gets built around a
   guess. Same idea as the `intellengine-context-pack` skill, platform-side.
3. **GrantBot v1.**
4. **IntellEngine steps 4–6.**

---

## The premise to get right before designing anything client-shaped

**OCCUPANCY IS PROFILE-FREE. `clients.client_profile` DOES NOT DECIDE WHETHER A GRANT
SURFACES.** This is locked architecture in `CLAUDE.md`, and it is repeated here because it is
the premise a planner reaches for first and gets backwards — "the matching profile drives
matching" is the intuitive reading and the wrong one.

Verified in `lib/grants/engine.ts`: the only consumer of `client_profile` is
`enrichMatchWithProfile`, which returns early unless `fit_score >= 2`. It writes NARRATIVE —
why-this-org, concept framing — onto matches that have *already scored*. Seats are decided from
the grant, the rubric, and the RAW client fields: `org_type`, location, `primary_funding_needs`,
`hard_constraints`, the intake narrative. The split is deliberate and load-bearing: a distilled
profile fed to the scorer pushed it into itemised seat-matching and buried integrative-fit
clients (incident, PR #138 closed → #140; the `profileInvariant` flag guards it).

Three consequences worth stating outright:

- **"Keep the profile current so we never miss a grant" is aimed at the wrong artifact.** What
  decides surfacing is the FACTS. Loading a client's facts *is* the keep-matching-current work.
- **A stale `client_profile` costs narrative quality, not coverage.** Worth fixing; not a
  matching bug.
- **Any future "learn from likes and dislikes" work is net-new against the SCORER**, not a
  matter of enriching a profile.

### What the feedback loop actually is today

| Signal | State |
|---|---|
| Client rejects a horizon/forecast grant | **Closed.** `forecast_rejections` (0053) is read by `lib/grants/forecast-relevance.ts` and hides the row *before* ranking. |
| Staff match feedback (agree / corrected score / reason) | **Captured, not consumed.** `match_feedback` has writers and readers across the console and portal, and zero references in `engine.ts`. It informs humans, not the scorer. |
| Client approves / passes / expresses interest in a card | **Not read back at all.** Drives workflow, not future scoring. |

Sequencing decision: **the feedback loop goes last.** It is the only item on this roadmap that
can quietly make matching *worse*, and `match_feedback` needs real accumulated rows before
anything learns from them.

## Constraints to carry into GrantBot v1

These came out of the analysis behind the sequencing decision. They are recorded because
each one is cheaper to build in from the start than to retrofit.

- **No second profile blob.** Facts with rules live in typed columns or tables (they need
  validation, dates, uniqueness — a blob cannot answer "is this SAM registration expired").
  `client_profile` stays a DERIVED view, regenerated from facts and never hand-edited. The
  richer "drafting profile" is a RENDERER over facts plus documents — `buildContextPack` already
  is one — not a stored artifact that goes stale. Two jsonb profiles on `clients` would both
  drift and neither would be authoritative.

- **Three fact families have no home yet, and wait for a real consumer:** authorized official
  (absent from the schema entirely), structured grant history (`federal_grant_history` is one
  free-text column), and relationship/narrative context (belongs in documents plus GrantBot's
  conversation store, not a column). Their consumer is drafting / IntellEngine step 6, not
  GrantBot v1.

- **Uploaded documents are the corpus, and the bytes are permanent.** Extraction parses a file
  in memory and stores only a synopsis plus proposed fields — but `storage_bucket` /
  `storage_path` keep the file, extraction is re-runnable by design, and both parsers are
  deterministic. So document CONTENT is unindexed, never discarded, and re-parsing stored
  objects later is the same operation as persisting text now. **The one way to actually lose it
  is the delete control**; loaded profile documents should be treated as permanent records.

- **A provenance store, not a blob.** Record `source`, `captured_at`, and provenance per
  context item. Then v2's messaging and Gemini capture are new *writers* into the same
  store. A concatenated blob makes v2 a rewrite. This is the single v1 design decision that
  determines whether v2 is additive.

- **Document text is not persisted today.** Extraction keeps a synopsis plus proposed
  profile fields and discards the text, so "seeded with the client's docs" currently means
  seeded with *synopses*. Three options, to be decided deliberately rather than discovered:
  synopsis-only (free, probably enough to start), re-parse on demand per turn (cheap to
  build, slow and repetitive), or persist text at extract time (one migration).
  **Persisting text means holding client financials as searchable text — flag that at the
  point of decision, not after.**

- **Staleness labeling is mandatory.** Every assembled context item carries a source and a
  date — live-from-platform vs pasted-on-DATE. Without it, a thread that opens "picking up
  where we left off" will treat a three-week-old paste as current fact. This is the
  recurring failure mode of this codebase — *asserting more currency than it has* — and it
  is the one thing a conversational surface will do most confidently.

- **Shared instructions live in the repo, not a textarea.** They are the same class of
  artifact as the extraction prompt: they need review and a diff. Per-client tailoring and
  the pasted handoff are data; shared behaviour is code.

- **Org rules in the shared instruction set on day one.** Paid deliverables (grant research
  reports, scored lists, full NOFO analyses) never go to prospects or pre-engagement
  contexts; legal questions go to counsel; prime vs partner eligibility is never flattened;
  GRANTED is always all-caps; no em dashes and no signature blocks in client copy.
  **GrantBot's output goes out under Shannon's name**, so these belong in the instructions
  before the first draft, not after the first mistake.

- **The Request SME log doubles as GrantBot's eval set.** There is no LLM-output eval
  harness in this platform. The SME question log — real client questions with human answers —
  is the nearest thing to ground truth available, which is a second reason to build it
  (`docs/matching-pursuit-model.md` §4, §5b item 2).

- **`before_you_approve` client-facing remains the cheapest client-facing win** in the
  model: the field is populated and three staff renderers exist to copy. Caveat: written in
  staff voice, so read a dozen real values before shipping them to clients.

---

## Also-open small threads (parked, not bugs)

- **"Preparing your grant matches" on a profile *edit*.** A confirmed client saving their
  profile still gets the 3-second first-login celebration screen. Cosmetic; reads oddly for
  an edit rather than a first confirmation.
- **Teammate invite reintroduction.** Unmounted from `/welcome` (not deleted — the component
  and `inviteTeammateAction` are intact and working) and intended to return as its own
  first-login action item.
- **The `intellengine_drafts` jsonb race.** `app/api/intellengine/drafts/[id]/route.ts` does
  the read-modify-write on its own jsonb that 0079 fixed for `clients.intake_data` — same
  class, *higher* collision odds since autosave is machine-paced. Deliberately left: nothing
  downstream writes an append-only log, so the failure is "an autosave loses a key," which is
  recoverable. Its own brick, and the model for it already exists (`merge_client_intake`).
