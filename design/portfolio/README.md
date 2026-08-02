# Portfolio — approved design reference

Source of truth for the Portfolio roster's visual design. Exported from Claude Design.
Open either file in a browser (`support.js` must sit alongside it) to render at its
native 1440×900.

| File | Status |
|---|---|
| `Portfolio v4 - Ink.dc.html` | **Current.** What the page is built to. |
| `Portfolio - Final.dc.html` | Superseded (v1). Kept because the tokens it settled — the `muted` stage scale, the reason priority — still hold. |

Sample rosters are **invented** and shared between the two files, so they read as one
fictional book. This repository is public; swap the sample orgs before committing if you
refresh an export.

## The page's central claim

A **split**: clients asking for something today as large cards, everyone else quieter
below. That much is unchanged from v1. What v4 changes is the second tier — a grid of
compact cards became a typographic **index**, because twenty quiet clients rendered as
cards sat in the same weight class as seven urgent ones and flattened the whole point.

The rule lives in `lib/clients/portfolio.ts`. Reasons are a priority list, not a set — a
client can trip several and the card has room for one strip:

| Reason | Threshold | Why it outranks the next |
|---|---|---|
| Question waiting | any | a person is waiting on a human answer |
| Deadline | ≤ 30 days | a clock is running and can't be paused |
| Alerts | ≥ 6 | real work, but not time-boxed |

Thresholds are **config**, not literals — `PORTFOLIO_ALERTS_THRESHOLD` and
`PORTFOLIO_DEADLINE_DAYS` override them without a deploy. Six is a judgement about how
big a backlog has to be before it's a problem, and losing that argument shouldn't cost a
release.

## The ink direction is page-scoped

v4 is a different visual system from the rest of the console, and only this page has
been redrawn in it. Three tokens exist **for this page alone** and collapse into the base
scale if Design carries the direction across:

| Token | Value | Against |
|---|---|---|
| `SURFACE.ground` | `#E9E7E0` | `SURFACE.page` `#F1EEE8` everywhere else |
| `RADIUS.sharp` | `2px`, 1px `LINE.edge` rule, **no shadow** | `RADIUS.card` `14px` + `ELEVATION.card` |

Two deliberate departures from the drawn values:

- **Masthead is `BRAND.navy`, not `#0A1420`.** It sits flush beneath the global command
  band. Honouring the darker value means either a seam across the top of one page or
  repainting the nav on every page — and the nav hasn't been redrawn.
- **The book pipeline bar has five segments, not four.** The drawn legend shows
  unassessed / approved / in pursuit / passed and omits *with client*, which the sample
  roster happened to have empty. Dropping a real stage would stop the segments summing to
  the total printed directly above them.

## Contrast

Design's note, and it corrects v1: the same `#6B7480` passes on a white card (4.8:1) and
fails on the page ground (3.8:1). On `#E9E7E0` the small-text floor is `#5b6472`.

v1 snapped `#6B7480` → `INK.subtle` (`#8A93A0`), which is *lighter* and fails harder on
the new ground. v4 splits by background instead: **ground-level type is `INK.muted`
(`#5B6472`), card-level labels are `INK.subtle`.** They look inconsistent side by side in
the diff because they answer to different backgrounds.

Same reasoning behind two new stage values: `STAGE.client.deep` (`#856210`, the index's
deadline dates — even `client.text` falls under the floor on the ground) and
`STAGE.approved.onDark` (`#7FC4D4`, teal reversed out of the masthead).

## What v4 unlocked, and what's still blocked

Two figures v1 had to drop are now real:

| Element | How |
|---|---|
| "Oldest sat 41 days" | `review_cards` still has no `created_at`, but `match_attempts` does — and `outcome='carded'` **is** the moment a card came into being. First carded attempt per (client, grant) is when that alert appeared. Falls back to the plain count for manual adds, which never went through the engine. |
| "Draft 40%" | `intellengine_drafts` + `draftProgress(status)`. **Step** progress through scope → compliance → build, the same figure the client dashboard shows as "step N of 4" — not a claim about narrative written, and the strip says "of the flow" so it can't be read as one. |

Still not implementable as drawn:

| Element | Resolution |
|---|---|
| Questions waiting | **No question store in the schema** — in-app messaging isn't built. Wired through at a permanent zero and rendered in the design's own inactive states: the grey message tile on cards, and a muted rather than lit-teal figure in the masthead. When questions ship, all of it lights up with no layout change. |
| Backlog · 8 wks sparkline | Dropped. Needs eight weekly snapshots of a number nothing else on the page needs historically — a tally table, a nightly cron, and a migration. Its own PR. A flat placeholder bar would be a fabricated trend. |
| "2 letters out" | Dropped. Letters of support aren't modelled anywhere; the string only exists as a NOFO constraint keyword. |
| Money footer / summary tiles | Still gone, as of v1. The masthead's figures replace them, so admins have no "outstanding" at a glance on this page. Flag if that's wrong — a deliberate consequence of following the design, not an oversight. |

## Edge states the mockup doesn't draw

- **No action clients** — the section collapses to one line and the index takes the page.
- **"And that's all"** renders only when the cards leave a gap in the last 4-up row
  (`action.length % 4 !== 0`). Filling the row exactly would strand it alone on a fresh
  row, reading as a missing card.
- **More than twelve action clients** — the grid wraps and the page scrolls. No cap;
  clipping would lose clients, and the mockup's zero-scroll only holds at exactly 900px.
- **Decoration is ornament.** The three vertical rules are set as a fraction of the width
  rather than aligned to the card grid — at the drawn 1440 they don't line up with it
  either. The oversized corner figure is the open-alert count.

## Index ordering

Three columns read **down**, not across. The index is alphabetical and only usable if
A-to-Z runs down each column in turn, so the list is chunked into three stacks. A single
grid with row auto-flow orders it across, which is unreadable at a glance.

## One shared derivation

Every client's mini bar, the masthead's book-wide bar, and the client dashboard's
pipeline card are the **same `derivePipeline`**; "alerts" is the **same predicate** as
`/matches` and the command band's badge. A number for one client reads the same wherever
it appears — that's the point of routing all of it through one function rather than
re-deriving per surface.

## Dropped from v1

The page-local name filter. The nav search finds a client and jumps straight to them,
which is strictly better than filtering a roster you're already looking at.
