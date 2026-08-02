# Client dashboard — approved design reference

Source of truth for the client dashboard's visual design. Exported from Claude Design.
Open either mockup in a browser (`support.js` must sit alongside it) to render at its
native 1440×900.

| File | Status |
|---|---|
| `Client Dashboard v8 - Ink.dc.html` | **Current.** What the page is built to. |
| `Client Dashboard - Final.dc.html` | Superseded. Kept because most of its card-level reasoning still holds and `Claude Code Handoff.md` documents it. |

`Claude Code Handoff.md` carries the earlier design intent and alignment/empty-state
rules. `github.md` records which codebase files the design was drawn against.

## Sample data is fictional

The sample client — "Northgate Health", Riverton County IL, and its figures — is
**invented**. This repository is public, so a real client's name and eligibility detail
does not belong in a design file, and nothing about the design depends on whose name is
in it. Keep it that way if you refresh either export.

Federal program names are real public NOFO titles, which is fine — the association
between a client and a pursuit is the part that must not be real.

## What the ink pass changes

The **masthead is the summary.** Identity, actions, and the entire pipeline sit on one
band of ink; the white identity strip and the pipeline card underneath it are both gone.
That is the design's actual argument — a client's funnel is not a card on the page, it is
the page's summary — and collapsing the two buys back roughly 90px, which is most of what
makes 1440×900 fit without scrolling.

Everything else is the same surfaces restyled to the ink system, minus one and plus one:
the **upcoming-deadlines rail card is dropped** (every deadline it carried is already on a
Grant Report row with a day count) and an **activity feed** takes its slot.

### The masthead arrangement is the Portfolio's, exactly

Four display figures → divider → a compact pipeline block that flexes to fill → divider →
the backlog sparkline pinned right.

The v7 pass built the five stages as full-width cells with their own figures instead,
which turned the strip into a row of six equal things with no hierarchy and no reason to
look at any of them first. **The four figures are the answers; the pipeline is the shape
behind them.** Unassessed (with its money), Decided, To next deadline, Portfolio assessed.

**The sparkline is load-bearing, not ornament.** Without it the pipeline block expands
into that space and the row reads unbalanced — which is precisely why it must be real. A
flat placeholder row would be a fabricated trend sitting where a real one is promised.

## The ink direction

Shared with the Portfolio — one visual system, built once. `SURFACE.ground` (`#E9E7E0`),
`RADIUS.sharp` (2px + a 1px `LINE.edge` rule, **no shadow**), Libre Baskerville for every
display figure. Both are still page-scoped: only these two screens have been redrawn.

**`BRAND.chrome` (`#0A1420`) is the dark surface** — the command band, both mastheads,
and the IntellEngine panel. An earlier pass used `BRAND.navy` to avoid repainting the
global nav; the nav was repainted instead, because the near-black is what makes the white
cards read as crisp planes. Against navy the whole page looks hazy, and that was the
single largest gap between the build and the reference.

Two tokens, not a retuned one. `BRAND.navy` is a text colour first — it is `INK.DEFAULT`,
on every heading and paragraph in the product — so it cannot be darkened to suit a dark
field without repainting all of that.

**The IntellEngine panel loses its gradient and glow.** That treatment was the one place
in the product allowed it, on the argument that this is where the AI does work. Next to
five squared flat cards it now reads as the odd one out rather than as emphasis. It is
still the only dark card on the page, which is the emphasis it actually needed.

### Colour is signal, not category

`STAGE_ON_INK` in `lib/brand.ts`. Orange means "this is owed"; everything past it is a
neutral ramp, so clearing a triage backlog literally drains colour off the page. Stage is
carried by position and label. Never below `.34` — a swatch under ~3:1 is invisible, and
the swatch is the only thing tying a zero-count stage to its segment.

This **reversed the Portfolio's first build**, which rendered its book bar in the full
stage palette. Two screens shipping together cannot render the same five stages two ways;
the Portfolio bar was retrofitted in the same PR.

### Teal is reserved

Teal means exactly one thing on the ink screens: **a person is waiting on you.** It used
to carry the Grant Report card's eyebrow, its strip and its button, which made it read as
that card's brand colour. Those are now `INK.muted` and navy.

The card's 3px top edge and its row dots survive as teal because they are STAGE markers
from the `STAGE` scale, not decoration. That scale still uses teal for "approved" on white
cards — a tension worth naming: colour-as-signal and colour-as-stage coexist, and only the
ink surfaces have been resolved to the first rule.

**Two orange tokens, not interchangeable.** `BRAND.orange` (`#E4761F`) for fills, display
figures, and anything on ink. `BRAND.orangeDeep` (`#A8501A`) for **any small text on a
light ground** — brand orange tops out near 3:1 on white, so eyebrows, urgent deadline
labels and micro-chips are illegible in it however much the layout wants orange there.

**One unresolved collision.** The drawn ramp puts *with client* and *passed* both at
`.34`. That reads fine in the mockup because its sample client has zero at the with-client
stage; when a client sits at both, the two swatches are identical. Shipped as drawn and
flagged — a monotonic ramp is a design decision, not a bug fix.

### The bar is weighted by count, not money

The mockup weights its segments by dollars (its flex values are the award figures). Money
here is an estimate of an estimate and the counts printed directly beneath the bar are
exact, so a money-weighted bar under exact counts invites "why don't these match" from
every reader forever. Counts also make the drain-the-colour behaviour literal.

## The ambient IntellEngine note

**Deterministic, not model-authored.** The requirement is that the note names actual
records and never offers generic advice, because one vague note destroys the credibility
of every real one. A rule that fires only on a specific, checkable pattern satisfies that
by construction — it cannot invent a cluster or be confidently wrong about a count. A
model on the render path could do both, could not be tested from a sandbox, and would put
an LLM call in the critical path of a page load.

Two of the four note types ship (`lib/clients/ambient-note.ts`):

| Type | Fires when |
|---|---|
| Clustering | ≥3 unassessed grants share a funder with something already approved or in pursuit |
| Staleness | An approved grant has a deadline inside 45 days and no draft started anywhere |

The attention card also lost its **"Grant proposals"** pinned row: the IntellEngine panel
sits directly below and says the same thing with far more detail, so at zero the row
communicated nothing and at any other count it was a worse copy of the card.

**Blocked dependency** is already the "N data sources need attention" row above it.
**Rejection pattern** needs clustering over free-text `decision_reason` — a genuine model
problem, and not faked in the meantime.

Renders nothing when no rule fires, which is the intended common case. Suppressed at 4+
other attention rows, and it counts toward the card's badge when it does fire — it names a
specific piece of work and points at it, which is the same claim every other counted row
makes.

**Dismissal is not built.** "Does not return until the facts change" needs persisted
state, i.e. a migration. The note only exists while its condition holds and clears itself
when you act, so it should not need dismissing; add it if it turns out to be noisy.

## What is real, and what is blocked

Real now:

| Element | How |
|---|---|
| Dollar rollup | `grants.award_range_*` summed. **Estimated award ceilings, not expected receipts**, and the marker is inline on the Unassessed label rather than a caption under the strip. Grants with no published figure are counted on the pipeline line — a $31M pipeline with three unpriced grants is a different fact from one with none. |
| "Portfolio assessed" | Everything past triage over the total. Assessed means a human made a call, not that the call was yes. |
| "Updated 4h ago" | `match_attempts` with `outcome='carded'` — when the engine last produced a card for this client is exactly when the list last changed. |
| **Backlog · 8 wks sparkline** | **Reverses the Portfolio pass's conclusion.** A general trend does need a snapshot table; this specific one does not, because both edges of "untriaged" are already timestamped — a card *enters* the backlog at its first carded attempt and *leaves* at the earliest of `interested_at` / `sme_released_at` / `sent_at` / `decided_at`. Given an interval per card, the count at any past instant is how many intervals span it. `lib/clients/backlog.ts`. Cards with no carded attempt (manual adds) cannot be placed in time and are counted as `unplaceable`; the chart hides itself rather than draw a series built on half a book. |

Blocked, and rendered as such:

| Element | Resolution |
|---|---|
| Client questions | No backing table — in-app messaging isn't built. Shared blocker with the Portfolio. |
| "Since you were last here" | Needs a per-user `last_viewed_at`. The card ships as **"Recent activity"** with a rolling 14-day window instead, built from timestamps the work paths already write (first-carded, decided, released, draft updated). Same layout; only the boundary changes when the marker lands. |
| "Dr. Whitfield opened Rural Health Network" | Nothing records a client-side portal read. Needs an event stream. |
| IntellEngine "62%" + its checklist | `draftProgress` is a four-step ladder, so it is 25/50/75/100 — 62% is not representable, and the drawn checklist rows ("Budget frame · 4 years, $1.9M") are content-specific and unbacked. Layout kept, real ladder kept. |
| "Consortium letters · 2 outstanding" | Letters of support are not modelled anywhere. Same blocker as the Portfolio's "2 letters out". |
| Ambient-note dismissal | Needs persisted per-client state, i.e. a migration. Not built — see below. |
| "Triage window closes Aug 4" | Still no triage-window field. The slot carries the nearest real deadline, labelled as one. |

## Fit is `/3`, not `/4`

The mockup draws `3.4/4` and `2.1/4`. `fit_score` is the engine's **1–3 ordinal** — a
seat ceiling with strength placed inside it. The rule the design states (always show the
denominator) is right and shipped; the denominator is just 3.

## The IntellEngine no-draft state recommends, it does not wait

"No drafts yet. Start from an approved match." plus a New draft button is a tool sitting
idle: correct, useless, and a large dead box in a 1fr column beside a Grant Report card
carrying real rows. The empty state instead **names the approved match that should be
scoped next** — nearest deadline, nothing started — against a 2px orange rule, with its
funder and award, and one italic-serif sentence on why it is that one.

The sentence is assembled from facts, and every clause drops when its fact is missing
rather than being guessed at, so it gets shorter instead of getting invented. "It is the
only approved match with nothing drafted" is only said when that is true.

Primary is **"Scope this one"**, secondary is "Pick another" — the difference between a
tool waiting for input and a colleague pointing at something. "Scope this one" carries
`?start=<cardId>` to the IntellEngine hub, which opens its picker with that grant first.
Deliberately **not** an auto-create on mount: a mutation fired from a URL means a browser
refresh silently produces a second draft.

**Fallback:** with no approved match at all there is nothing to recommend, and the panel
says so in one line.

**Height is a constraint.** This shares a `1fr` row with ~330px of real content, so the
empty state has to fit the same box or its buttons clip out of existence. Do not add
explanatory copy to it.

### Nothing on these pages is a pill

Cards, buttons and inputs are all `RADIUS.sharp` (2px); only count badges stay round. No
box-shadow anywhere — a shadow is paper lifting off a desk, and a hairline reads as drawn.

## The IntellEngine panel has three states, and is never empty

| State | When | What it says |
|---|---|---|
| **Draft in progress** | a draft exists | title, step progress, checklist, Resume / New draft |
| **Ready to scope** | approved matches exist, none drafted | names the nearest-deadline one against a 2px orange rule, one italic-serif line on why — **Scope this one** / Pick another |
| **Waiting on an approval** | nothing approved yet | strip names the blocker and the unassessed count; shows the closest candidate anyway with its fit; primary is **Review the N**, routing to what unblocks it |

The waiting state is the one most clients are actually in, and it is the one that looked
saddest. Showing the closest candidate even though it is unapproved is the point — knowing
what an approval would unlock is what makes the reader go approve something.

Its sentence names **only factors the engine rated strong** (`factor_scores`, #105). Cards
scored before those shipped have none, and it degrades to the shorter half of the sentence
rather than asserting anything about eligibility it cannot support.

"Scope this one" carries `?start=<cardId>` to the IntellEngine hub, which opens its picker
with that grant first. Deliberately **not** an auto-create on mount: a mutation fired from
a URL means a browser refresh silently produces a second draft.

**Height is a hard constraint.** The panel shares a `1fr 1fr` row with a Grant Report card
carrying ~330px of real content, so every state must fit the same box. Do not add
explanatory blocks, feature lists or readiness checklists to any of them — if something
needs saying, fold it into the italic line.

## States not drawn

- **Nothing needs attention** — the card keeps its frame (a card that vanishes changes the
  page's shape) but collapses to a single confirmation line, not an eight-row-tall centred
  block.
- **Long client names** — 30px overruns the masthead around thirty characters. Steps to
  24px, then 20px, then truncates with the full name on hover. Wrapping to two lines costs
  height the page does not have at 900px.
- **Both columns bottom out level**, and the *activity* card is the slack absorber. An
  earlier build let the *attention* card absorb it, which is exactly the wrong one — it is
  the card most likely to be nearly empty, and stretching it produced a tall white void.

## Where the earlier mockup is not implementable as drawn

Still true, still shipped this way:

| Element | Resolution |
|---|---|
| Notification bell | A real control that opens and says there is no staff feed yet. An inert icon would be the "Soon" nav links again. |
| Pipeline stage columns | Not clickable — no per-stage filter route exists. The hover/cursor affordance is dropped so they do not advertise themselves as links. |

Global search (`⌘K`) is no longer on this list: it was omitted for want of a backend, and
#269 built one. It is live in the command band.

**"Not wired" is never a licence to change the layout.** Structure, spacing, and type
scale follow the mockup regardless of what is interactive.

## The console and the portal are separate layouts

`ClientDashboard` is mounted by both `app/(app)/clients/[id]/page.tsx` (`isStaff`) and
`app/portal/page.tsx` (`isStaff={false}`), and this design describes only the staff
console. `ConsoleBody` is the design; `PortalBody` is what the portal has always shipped,
and the Grant Report, IntellEngine and geography cards each take a `variant` for the same
reason. Converging the two is a decision someone should make on purpose, not a side effect
of a styling pass.

## Known contrast failures — not fixed here

Both are systemic and neither is a per-screen patch:

1. **`INK.subtle` (`#8A93A0`) is ~3.1:1** and fails AA everywhere it appears, across every
   page. Darkening it is one token change with a product-wide visual effect and wants its
   own PR, looked at against the other screens.
2. **White on `#E4761F` is 3.04:1** — passes for large text, fails for the 12.5–13px
   primary button labels. Clearing 4.5:1 means burnt orange on every primary button in the
   product, which is a brand decision rather than a fix.

`BRAND.orangeDeep` resolves the small-orange-text case, which is the part that was
actionable inside this screen.
