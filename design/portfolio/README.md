# Portfolio — approved design reference

Source of truth for the Portfolio roster's visual design. Exported from Claude Design.
**`Portfolio - Final.dc.html` is the approved mockup** — open it in a browser
(`support.js` must sit alongside it) to render at its native 1440×900.

Sample roster is **invented** (Brightwater Health, Marbury County, …). This repository is
public; swap the sample orgs before committing if you refresh the export.

## The page's central claim

A **split**: clients asking for something today as large cards, everyone else in a quieter
grid below. The rule lives in `lib/clients/portfolio.ts` — thresholds as named constants,
because "six alerts is a backlog" is a judgement that will get argued with and the
argument shouldn't require reading JSX.

Reasons are a priority list, not a set — a client can trip several and the card has room
for one chip:

| Reason | Threshold | Why it outranks the next |
|---|---|---|
| Question waiting | any | a person is waiting on a human answer |
| Deadline | ≤ 30 days | a clock is running and can't be paused |
| Alerts | ≥ 6 | real work, but not time-boxed |

## Question waiting is wired, permanently zero

There is **no question store in the schema** — in-app messaging isn't built. The reason is
wired through anyway and renders in the design's own **inactive** state (the grey
`message-square` tile, which the mockup already draws on four of its seven cards). When
questions ship it becomes a real count with no layout change.

What is *not* done is fabricating the count so the mockup's sample roster reproduces. The
teal `border-top` and teal footer chip are question-driven, so they sit unused until the
feature lands.

## Where the mockup isn't implementable as drawn

| Element | Resolution |
|---|---|
| "oldest sat 41 days" | Dropped. `review_cards` has `decided_at` / `interested_at` / `overridden_at` / `sent_at` and **no `created_at`** — an untriaged card has none of them set, so the age of a waiting alert isn't recoverable. Chip reads "N waiting for review". Restoring it needs a migration. |
| Money footer / summary tiles | Removed with the old header. The design's context-bar counts line replaces the four-tile row, so admins lose "outstanding" at a glance on this page. Flag if that's wrong — it's a deliberate consequence of following the design, not an oversight. |

## Tokens

The quiet grid's bars use `STAGE[*].muted` — the same scale desaturated. Not the live
colours at lower opacity: opacity would let a big taupe segment on a settled client
out-shout a small orange one on a client that needs work, whereas a desaturated scale
recedes as a whole while still reading as the same funnel.

`triage` / `approved` / `passed` muted values come from the design. `client` and `pursuit`
are **derived** — the sample roster had no quiet client at those stages, so they were never
drawn. A future mockup specifying them wins over the derived values.

Values snapped to existing tokens rather than reproduced literally, per the single-source
rule: 13px/11px card radii → `RADIUS.card`; the compact tiles' half-strength shadow →
`ELEVATION.card` (a third elevation step is what the two-step scale exists to prevent);
`#C9CDD4` and `#B7BCC4` → `INK.faint`; `#6B7480` → `INK.subtle`.

## One shared derivation

Every client's mini bar is the **same `derivePipeline`** the client dashboard's pipeline
card uses, and "alerts" is the **same predicate** as `/matches` and the command band's
badge. A number for one client reads the same wherever it appears — that's the point of
routing both through one function rather than re-deriving per surface.
