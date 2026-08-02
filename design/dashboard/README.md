# Client dashboard — approved design reference

Source of truth for the client dashboard's visual design. Exported from Claude Design.
Open either mockup in a browser (`support.js` must sit alongside it) to render at its
native 1440×900.

| File | Status |
|---|---|
| `Client Dashboard v7 - Ink.dc.html` | **Current.** What the page is built to. |
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

## What v7 changes

The **masthead is the summary.** Identity, actions, and the entire five-stage pipeline
sit on one band of ink; the white identity strip and the pipeline card underneath it are
both gone. That is the design's actual argument — a client's funnel is not a card on the
page, it is the page's summary — and collapsing the two buys back roughly 90px, which is
most of what makes 1440×900 fit without scrolling.

Everything else is the same surfaces restyled to the ink system, minus one and plus one:
the **upcoming-deadlines rail card is dropped** (every deadline it carried is already on a
Grant Report row with a day count) and an **activity feed** takes its slot.

## The ink direction

Shared with the Portfolio — one visual system, built once. `SURFACE.ground` (`#E9E7E0`),
`RADIUS.sharp` (2px + a 1px `LINE.edge` rule, **no shadow**), Libre Baskerville for every
display figure. Both are still page-scoped: only these two screens have been redrawn.

The masthead uses `BRAND.navy`, not the drawn `#0A1420` — it sits flush beneath the
global command band, and honouring the darker value means either a seam or repainting the
nav on every page.

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

**Blocked dependency** is already the "N data sources need attention" row above it.
**Rejection pattern** needs clustering over free-text `decision_reason` — a genuine model
problem, and not faked in the meantime.

Renders nothing when no rule fires, which is the intended common case. Suppressed at 4+
other attention rows. **Dismissal is not built** — "does not return until the facts
change" needs persisted state, i.e. a migration. The note only exists while its condition
holds and clears itself when you act, so it should not need dismissing; add it if it
turns out to be noisy.

## What v7 unlocked, and what's blocked

Real now:

| Element | How |
|---|---|
| Per-stage dollar rollups | `grants.award_range_*` summed by stage. **Estimated award ceilings, not expected receipts**, and the masthead says so in one line rather than an "est." per cell. Grants with no published figure are counted and named — a $31M pipeline with eight unpriced grants is a different fact from one with none. |
| "Portfolio assessed" | Everything past triage over the total. Assessed means a human made a call, not that the call was yes. |
| "Updated 4h ago" | `match_attempts` with `outcome='carded'` — when the engine last produced a card for this client is exactly when the list last changed. |

Blocked, and rendered as such:

| Element | Resolution |
|---|---|
| Client questions | No backing table — in-app messaging isn't built. Shared blocker with the Portfolio. |
| "Since you were last here" | Needs a per-user `last_viewed_at`. The card ships as **"Recent activity"** with a rolling 14-day window instead, built from timestamps the work paths already write (first-carded, decided, released, draft updated). Same layout; only the boundary changes when the marker lands. |
| "Dr. Whitfield opened Rural Health Network" | Nothing records a client-side portal read. Needs an event stream. |
| IntellEngine "62%" + its checklist | `draftProgress` is a four-step ladder, so it is 25/50/75/100 — 62% is not representable, and the drawn checklist rows ("Budget frame · 4 years, $1.9M") are content-specific and unbacked. Layout kept, real ladder kept. |
| "Consortium letters · 2 outstanding" | Letters of support are not modelled anywhere. Same blocker as the Portfolio's "2 letters out". |
| "Triage window closes Aug 4" | Still no triage-window field. The slot carries the nearest real deadline, labelled as one. |

## Fit is `/3`, not `/4`

The mockup draws `3.4/4` and `2.1/4`. `fit_score` is the engine's **1–3 ordinal** — a
seat ceiling with strength placed inside it. The rule the design states (always show the
denominator) is right and shipped; the denominator is just 3.

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
