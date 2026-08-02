# Grant review — approved design reference

Source of truth for the staff grant-review screen. Exported from Claude Design; open
`Grant Review - Ink.dc.html` in a browser (`support.js` must sit alongside it) to render
at its native 1440×900.

Built at `app/(app)/clients/[id]/roadmap/[cardId]`. Third screen in the ink system, after
Portfolio and the client dashboard — same tokens, defined once in `lib/brand.ts`.

## Sample data is fictional

"Northgate Health" and its eligibility detail are **invented**. This repository is public.
Federal programme names are real public NOFO titles, which is fine — the association
between a client and a pursuit is the part that must not be real.

## What this screen is

One matched grant, for one client, reviewed by one person, on one screen with **no
scrolling**. It answers three questions in order: is this worth sending, is the machine's
score right, and should we draft a concept first. The reviewer arrives from the client's
Grant Report and returns there the moment they decide — dozens of times a morning.

`grid-template-rows: minmax(0,1fr)` on the content grid is **required**, not tidiness.
Without it the implicit row sizes to max-content, both columns grow past the frame, and
the page scrolls.

## The argument the page makes

A grant scores Conditional for **one** reason, and the fix usually already exists. Score →
weakness → mitigation is a single chain of reasoning, and the surface this replaces
scattered it across four screens without ever stating it.

Three things carry it, and all three are load-bearing:

- The rationale paragraph states it in prose, **with the blocking sentence in bold**
- The fit factors light **exactly one** row in orange, so the eye finds the blocker
  without reading
- The concept proposal exists to carry the mitigation to the client

Do not let copy edits erase the bold sentence or spread the orange to a second factor.

### Where that argument is grounded

Nothing in it is written by this page:

| Part | Source |
|---|---|
| The bold blocking sentence | The weakest factor's **own** `rationale` string from `factor_scores`. Not a rewrite of it — which is why it can be bolded as the cap without asserting a reason the score does not rest on. |
| The lead paragraph | `why_this_org[0]`, cut at a sentence boundary. Cut, never paraphrased. |
| The mitigation | `reasoning_context.consortium_rationale`, when the engine produced one. Omitted when it did not. |

**When more than one factor is short, the sentence says so** — "(2 other factors also
scored short)". The single lit row would otherwise imply the lead is the only problem,
which is the one way this layout can mislead.

## Fit factors

Six factors, `lib/report/fit-factors.ts`. Three segments per row, N filled, the word
underneath the bar rather than beside it — beside, the name and the bar pin to opposite
edges and a gap opens down the middle that the eye reads as a column of nothing.

**Rating is segment count, not hue.** The previous build ran green / gold / red side by
side, distinguishable only by the one channel a red-green viewer cannot use. Counting
filled segments works for everyone and survives greyscale printing.

`insufficient_data` fills **zero** segments and reads "Not assessed" — never "Weak". Not
knowing and knowing it is bad are different facts, and collapsing them would let a card
scored before a factor existed read as a finding about the client.

The lit row is the single lowest-rated factor, ties broken by a fixed order so the pick is
stable across renders. **Nothing lights when every factor is strong** — an orange row on a
clean card would invent a blocker.

The factors block is the rationale card's only flexible child, so it is what clips if
anything above it grows. Check the six rows still fit before shipping a change to the
overview card.

## The score is immutable

There is deliberately no editable score field: a number a reviewer can overwrite is a
number nobody can calibrate against. Agree / Disagree writes to `match_feedback` via
`POST /api/feedback` and trains future scoring only, and the caption says so.

**Disagree is not a bare button, and that asymmetry is the API's.** The endpoint rejects a
disagree with no reason — the reason *is* the calibration signal, and a thumbs-down with
no text teaches the scorer nothing. So agreeing is one click and disagreeing opens a line
to say why. The mockup draws two equal buttons; this is the right departure.

Feedback is append-only, so the page reads back whether **this** reviewer already weighed
in. Without that read the control would stack a duplicate row on every visit.

## Eligibility folds into the overview card

It is a property of the grant-for-this-client, read once on the way to a decision. A
separate box gave it the same weight as the decision itself.

The verdict is computed, not displayed as a list — `computeEligibility` in
`lib/intellengine/eligibility.ts`, which already existed for the IntellEngine compliance
step and now also returns **which** entity-type clause matched. A verdict that cannot say
what it qualifies *under* is not a verdict, it is a colour.

The chip is **neutral, not green**. Green is retired from this screen, and a green chip
would also overstate what a keyword match against NOFO prose establishes. The limits line
quotes `ineligible_entities` verbatim — an eligibility exclusion restated in our own words
is a legal claim we did not make.

## Colour

Ground `SURFACE.ground`, chrome `BRAND.chrome`, cards 2px + 1px `LINE.edge`, no shadows.
Same as the other two ink screens.

**Two orange tokens, and their mirror image.** `BRAND.orange` for fills, display figures
and anything on ink; `BRAND.orangeDeep` (`#A8501A`) for any small text on a light ground.
And the part that is easy to get backwards: **on ink the warm accent goes lighter, not
darker** — the verdict word on the dark score panel is `BRAND.amberOnDark` (`#E2B457`),
because brand orange there falls below AA. Same accent, opposite directions, chosen by
what is behind it.

A tint in the same hue as the text on top of it cannot buy contrast — raising an orange
chip's alpha behind orange text makes it worse, not better.

`RATING.filled` / `RATING.empty` are the bar segments. `BRAND.reject` (`#B4462F`) is the
reject control — deliberately not the shadcn destructive red and deliberately muted:
rejecting a grant is a routine, reversible call an analyst makes dozens of times a
morning, not a destructive action that should shout.

**Teal is not used on this screen at all.**

### Green and gold are NOT retired product-wide

The build prompt asks for that. It is applied *here* — nothing on this screen uses either,
and killing the green/gold/red fit bars fixed a real colour-blindness problem.

Product-wide it is a different question. Green and gold are `STAGE.pursuit` and
`STAGE.client` — two of the five pipeline stages, shipped on both other ink screens —
plus the client-status chip and the geography card's "Qualifies". Retiring them means
redesigning the stage scale, with replacements specified for all five. That is its own
decision, not a side effect of this screen.

## Two known failures, unresolved product-wide

1. `INK.subtle` (`#8A93A0`) is ~3.1:1 and fails AA everywhere it appears
2. White on `#E4761F` is 3.04:1 — every primary button in the product

Both want one decision, not per-screen patches. Neither is touched here.

**Resolved in the pass after this one**, product-wide as they needed to be: `INK.subtle` is
`#6E7683` (4.58:1 on white), and white-on-orange fills use `BRAND.orangeFill` (`#B85A17`,
4.65:1) while `BRAND.orange` keeps every text-free fill. The `hover:opacity-90` those
buttons carried had to go with it — ancestor opacity composites the label too and dropped
the pair back to ~3.95:1 exactly while you were pointing at the button.

## There are two grant-review screens

This one is client-scoped, reached from a client's Grant Report. `/review/[id]` is the
**cross-client Matches worklist**, reached from the command band's badge, and it is
unchanged — so staff now have two grant-review surfaces that look nothing alike.
Converging them is a follow-up.

## States

| State | Behaviour |
|---|---|
| After release or reject | Returns to the Grant Report. The return line names how many are left. |
| Agree / Disagree pressed | Confirmed state replaces the buttons and names which way it went. |
| No weak factor | Nothing lights, and the consequence line reads "no blocking factor — ready to go out" rather than assuming one exists. |
| No factor scores at all | Cards predating #105 say so and point at re-running matching, rather than rendering six empty bars. |
| Long grant titles | Two lines at 22px is the budget; the summary clamps to four lines so the meta row holds its place. |
| Not account-managed | The client makes the pursuit call on their own copy, so the decision card says that instead of offering a release. |
| Prospect | No portal, so the terminal action is the cold one-pager. Admin-only. |

## Out of scope here

The generated concept proposal's expanded editing state. The card is status-driven rather
than hardcoded empty, so it is not written as though it will stay small forever; the
generated draft renders below the frame, because reading a multi-page document in a 386px
rail is not a thing to design toward.
