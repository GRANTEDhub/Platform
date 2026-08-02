# Grant Report — approved design reference

Source of truth for the client's grant-report queue. Exported from Claude Design; open
`Grant Report - Ink.dc.html` in a browser (`support.js` must sit alongside it) to render
at its native 1440×900.

Built at `app/(app)/clients/[id]/roadmap`. Fourth screen in the ink set:
**Portfolio → Client Dashboard → Grant Report → Grant Review.** One token set across all
four.

## Sample data is fictional

"Northgate Health" is **invented**; this repository is public. Federal programme names are
real public NOFO titles, which is fine — the association between a client and a pursuit is
the part that must not be real.

## Nine rows, one screen

The build this replaces showed about two and a half. That is not a queue: you cannot tell
what you are facing, and you cannot triage in any order but top-down.

Row height (66px) and gap (8px) are fixed, and the list container is sized to an exact
multiple of them. A tenth row is **fully hidden** rather than half-showing, and
`scroll-snap` keeps it that way while scrolling — a 30px sliver of a card reads as a
rendering artefact, not as a scroll affordance. When there are more than nine, a line under
the list states the true total, so the page never claims a number it is not showing.

Pagination was the alternative and is worse for a list this size.

## A sub-page, not a top-level one

Portfolio and the client dashboard open with a full ink masthead because they are where
you start. This hangs off a client's dashboard, so it opens **white**: back link, 23px
title, status line, four compact 19px stats beside the primary action. Promoting it to a
masthead would make every screen the front page of something.

## A real bug this screen exposed

`review_cards.fit_score` is **nullable** (`0001_init.sql:159`) and `toReportItem` coerced
it with `?? 1`. So an unscored card rendered as a confident **"Weak"**, with a 1-of-3 dial
— on the client's own Grant Report as well as staff's — and `reportStats.avgFit` counted
those phantom 1s, under-reporting the book.

Fixed at the shape: `fitScore: 1 | 2 | 3 | null`, `band: FitBand | null`, an explicit
unscored dial (a dash and "Not scored"), and averages computed over scored items only with
the excluded count available so a surface can say what the mean is *of*. Unscored sorts
below every scored card in both the shared sort and the queue sorts — it is an absence,
not a zero, and ranking it first or last by accident is how it gets read as one.

This touches the shared portal surface. That is the point: leaving a client's own report
calling an unassessed grant "Weak" is worse than the type change.

## The dial carries the score

Every circle in the old build was an identical grey "2 · CONDITIONAL", which made the
largest element on every card carry no information. Ring, numeral and verdict word all take
their colour from the score: **Strong** navy, **Conditional** grey, **Weak** burnt orange
with a faint tint, **unscored** a dash on the inactive neutral.

Rating is carried by colour *and* the word — never by a green/amber/red scale, which is
close to worst-case for red-green colour blindness.

## Closed-but-unreviewed is what this screen must surface

A grant whose deadline passed while it sat in the queue is not a stale row, it is a **miss**:
matched, surfaced, never looked at, now unwinnable. The old list rendered it identically to
a live grant — same black date, same card — so nothing ever said it had happened.

Treatment: tinted card background `#F4F1EA`, burnt left edge, burnt date, and "closed 6
days ago" where the countdown goes. Plus a header stat and a toolbar action.

**Closed rows float to the TOP of every sort**, not the bottom. Burying them is how they
went unnoticed in the first place.

### Not an opacity dim

Design tried ancestor `opacity` and it dragged twelve text nodes to ~2.9:1, including the
two strings that carry the whole point of the treatment. Ancestor opacity composites the
entire subtree and **cannot be corrected by any colour token inside it**. An explicit tint
keeps every value's contrast under our control.

### The archive prompt is a real action

"2 closed before review — archive?" runs `POST /api/review/archive-closed`, which records
`decision='passed'` with the reason "Closed before review". A prompt that only points at
the problem is the dead affordance this redesign keeps removing, and the header stat
already points at it.

Two properties worth keeping:

- It **re-derives "closed" server-side** rather than trusting the ids it was handed. A
  stale tab, a hand-crafted request, or a race against a decision made in another window
  cannot archive something still live. Ids that no longer qualify are skipped and counted,
  not rejected — partial success is the honest outcome when the list moved underneath you.
- It writes **no `match_feedback` row**. The per-card Reject records one because a human
  judged the match wrong, and that is calibration signal. "Nobody got to it in time" is a
  fact about our capacity, not about the scorer; feeding it in as a negative would teach
  the engine to stop surfacing grants it was right to surface.

Offered only where staff hold the queue (account-managed clients and prospects). On a
standard client the cards are the client's, and their deadlines passing is not ours to
close out.

## The card

Whole card is the click target — the per-row "View" button is gone; nine of them was eight
too many. **No per-row flag chips**; an earlier pass carried "Geo ~" / "No prime history"
and they were removed deliberately.

Left-edge accent: burnt for closed, orange for a grant carrying a **concern**, neutral
otherwise. "Concern" means the card's `before_you_approve` list is non-empty — the engine's
own check-this-first, which is the only field that means exactly that.

## Colour and type

Ground `SURFACE.ground`, chrome `BRAND.chrome`, cards 2px + 1px `LINE.edge`, no shadows —
same as the other three ink screens. Libre Baskerville for the page title, programme
titles, the fit numeral, deadline dates and the header stat figures; DM Sans for
everything else.

Two orange tokens, not interchangeable: `BRAND.orange` for fills, display figures and
anything on ink; `BRAND.orangeDeep` (`#A8501A`) for any small text on a light ground. On
ink the warm accent goes lighter (`BRAND.amberOnDark`), not darker.

Teal is not used on this screen.

**Green and gold are still not retired product-wide** — same position as the grant review
screen. They are two of the five pipeline stages plus the status chip and the geography
card's "Qualifies"; retiring them means redesigning the stage scale with replacements
specified for all five.

## States

| State | Behaviour |
|---|---|
| Empty queue | The payoff for clearing the loop, so it gets real space and a serif headline rather than a grey "no results" line. Per-bucket copy — "nothing rejected" and "the queue is clear" are different facts. |
| Search with no hits | A single line. Distinct from an empty bucket: one means you filtered it away, the other means there is nothing there. |
| Unscored grant | Explicit dial state, excluded from the average, sorted below scored cards. |
| More than nine | Scrolls; the count line states the true total. |
| Long titles | Single line, ellipsized, full title on hover. |
| After a decision | Returns here with the row moved to its new bucket and the counts updated. |

## Two known failures, unresolved product-wide

1. `INK.subtle` (`#8A93A0`) at ~3.1:1 — fails AA everywhere it appears
2. White on `#E4761F` at 3.04:1 — every primary button

Neither is touched here. **Both were fixed product-wide in the pass after this one** —
`INK.subtle` → `#6E7683`, and white-on-orange fills → `BRAND.orangeFill` (`#B85A17`), which
on this screen is the "Check a grant" button and the active bucket pill.

## Also removed

The client-decision activity feed that sat above this list. The client dashboard's activity
card carries client-side decisions now, and two places showing the same facts is one too
many on a screen built to fit nine rows.
