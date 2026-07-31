# GRANTED — client dashboard redesign

Attached screenshot is the approved design for the internal staff client-detail
page (`/portfolio/:clientId`). Build it to match. This is a **visual + layout**
change — no new data fetching, no schema changes, no new endpoints. Every number
on screen is already available from the existing client/matches/report queries.

Work through the PRs in order. Stop after each and let me review.

---

## Part 0 — read first: the rules we're fixing

The current dashboard is inconsistent, not ugly. These are the specific
inconsistencies that made it look unfinished. Do not reintroduce them:

1. **Four competing elevation styles.** Cards variously use a border, a border
   *plus* a shadow, a heavy shadow alone, and a flat tinted fill. Collapse to the
   two-step scale below. A card gets a border **or** a shadow, never both.
2. **Five different border radii** (6/8/10/12/16px) on sibling elements. Collapse
   to three.
3. **Metrics rendered in serif in some cards and sans in others.** All numerals
   are sans (DM Sans) with `font-variant-numeric: tabular-nums`. Serif
   (Libre Baskerville) is *only* for card titles, the page H1, and nothing else.
4. **The textured/patterned page background.** It sat on top of the hierarchy
   and made flat white cards read as holes. Page background is a flat warm
   neutral; cards are white. Texture appears in exactly one place — the
   IntellEngine panel.

---

## Part 1 — token spec

Add these as the single source of truth (Tailwind theme extension or CSS custom
properties, matching whatever the codebase already does — do not introduce a
second system). Replace hard-coded hex values in the touched components.

### Color — brand

| Token | Value | Use |
|---|---|---|
| `navy` | `#0B1E3A` | Nav band, primary buttons, headings, avatar fills |
| `navy-hover` | `#12305A` | Primary button hover, IntellEngine gradient end |
| `orange` | `#E4761F` | Single accent: primary CTA, active nav icon, counts needing action |
| `orange-hover` | `#C9631A` | Orange button hover |

### Color — surface & text

| Token | Value | Use |
|---|---|---|
| `page` | `#F1EEE8` | Page background (flat, no texture) |
| `surface` | `#FFFFFF` | All cards |
| `surface-sunken` | `#FBFAF8` | Inset fields inside white cards |
| `ink` | `#0B1E3A` | Primary text |
| `ink-muted` | `#5B6472` | Body / secondary text |
| `ink-subtle` | `#8A93A0` | Labels, metadata, "17 more" |
| `ink-faint` | `#B0B6BF` | Placeholder text, disabled chevrons |
| `hairline` | `rgba(11,30,58,0.06)` | Row dividers inside cards |
| `hairline-strong` | `rgba(11,30,58,0.09)` | Section / header bottom borders |
| `edge` | `rgba(11,30,58,0.13)` | Secondary button + input borders |

### Color — pipeline stage scale

The five stages are a **semantic scale**, warm at the front of the funnel, cool
at the back, taupe at the end. Each color means one stage and is used only for
that stage — as the dot, the tinted panel header, and the bar segment. Never as
decoration.

| Stage | Token | Value | Tint (headers) |
|---|---|---|---|
| Needs triage | `stage-triage` | `#E4761F` | `rgba(228,118,31,0.07)` |
| With client | `stage-client` | `#C9962B` | `rgba(201,150,43,0.14)` |
| Approved | `stage-approved` | `#2E7D91` | `rgba(46,125,145,0.06)` |
| In pursuit | `stage-pursuit` | `#0B7A5A` | `rgba(11,122,90,0.10)` |
| Passed | `stage-passed` | `#C9C2B8` | `rgba(11,30,58,0.06)` |

`#A87A1B` is the accessible text-on-white companion for `stage-client` — use it
for warning-state label text, never `#C9962B` itself.

### Type

Two families only. Load DM Sans (400/500/600/700) and Libre Baskerville (700).

| Role | Spec |
|---|---|
| Page H1 | Libre Baskerville 700, 19px, `-0.01em` |
| Card title | Libre Baskerville 700, 16–18px |
| Section label | DM Sans 700, 10px, `0.13em`, uppercase |
| Body | DM Sans 400, 12.5px, 1.5 |
| Row title | DM Sans 600, 13.5–14px |
| Row meta | DM Sans 400, 11.5–12px, `ink-subtle` |
| Metric — large | DM Sans 600, 24px, `line-height: 1`, tabular-nums |
| Metric — small | DM Sans 600, 18px, `line-height: 1`, tabular-nums |
| Button | DM Sans 600, 12.5–13px |

### Radius — three values, no others

- `radius-sm: 8px` — buttons, inputs, nav items, icon tiles
- `radius-md: 9px` — inline pill buttons inside card rows
- `radius-lg: 14px` — all cards
- Fully round (`999px`) — count badges and status chips only

### Elevation — two steps

- `shadow-card`: `0 1px 2px rgba(11,30,58,0.05), 0 2px 6px -1px rgba(11,30,58,0.07)`
  — every card on the page.
- `shadow-overlay`: `0 8px 24px -6px rgba(11,30,58,0.18), 0 2px 6px rgba(11,30,58,0.08)`
  — menus, popovers, the ⌘K palette, the scorer result panel.

No third step. No card gets both a shadow and a border. The only borders on
cards are the **deliberate 3px accent edges**: `border-top: 3px solid
stage-approved` on Grant Report, `border-left: 3px solid orange` on the scorer.

### Spacing

4px base. Page gutter 34px, vertical 20px. Card gap 16px. Card padding 16–22px
horizontal, 12–18px vertical. Card row padding `11px 20px`.

---

## Part 2 — PR 1: shell (top nav replaces the sidebar)

Delete the 226px left sidebar. Two stacked bars:

**Command band** — 58px, `navy`, 26px horizontal padding.
Left: logo mark 23px + "GRANTED" in Libre Baskerville 700 15px, `0.03em`.
Center: nav items, 13.5px, `radius-sm`, padding `7px 12px`. Inactive
`rgba(255,255,255,0.62)`; active is 600 weight on `rgba(255,255,255,0.10)` with
its icon in `orange`. Order: Portfolio · Ledger · Matches · IntellEngine ·
Prospecting · Pipeline · Sales · **More ▾**.
Right: search field (180px, `rgba(255,255,255,0.08)`, ⌘K hint in a 1px
`rgba(255,255,255,0.18)` box), bell, 29px avatar in `orange`.

Move the four unshipped destinations — Time, Invoices, Contracts, Settings — into
the **More** dropdown. They currently render as dimmed sidebar links with "Soon"
badges and read as broken. Settings is live, so it goes at the top of the menu,
separated by a divider from the three disabled items; the disabled ones keep
their "Soon" label and are not clickable.

**Context bar** — 60px, `surface`, `hairline-strong` bottom border, 34px padding.
Left: breadcrumb "Portfolio ›" then 30px client avatar tile, H1, status chip,
then org type · city, state · "Client since {date}" in `ink-subtle`.
Right: "Edit profile" (secondary: `edge` border, transparent fill) and "Refresh
matches" (primary: `navy` fill, refresh-cw icon).

Matches badge in the nav and the triage count in the pipeline card read from the
same source — never let them disagree.

**Transitions.** Nav item background `120ms ease-out`. More dropdown: opacity 0→1
plus `translateY(-4px)→0` over `140ms cubic-bezier(0.16,1,0.3,1)`. Refresh
matches spins its icon `700ms linear` while the mutation is in flight and the
label becomes "Refreshing…". Nav focus ring: 2px `orange` at 60%, 2px offset.

---

## Part 3 — PR 2: pipeline card (the page anchor)

Full-width card directly under the context bar. This is the most important
change in the redesign: **the pipeline is always populated, so it can never go
empty.** It replaces the matched-grants list as the top element.

Header row: "Grant pipeline" (serif 16px) left; right, `ink-subtle` 12.5px —
"{n} opportunities tracked · triage window closes {date}" with the date in
`ink-muted` 500.

Segmented bar: 11px tall, 3px gaps, each segment `flex: {stageCount}` and
`border-radius: 999px`, filled with its stage color. A stage with zero items
collapses to `flex: 0.001` so the bar still reads as five slots — do not drop
the segment.

Five equal columns below, divided by 1px `hairline` left borders (not on the
first). Each: 8px `border-radius: 2px` stage dot + label (12px, 600,
`ink-muted`), then the count at 24px 600 tabular-nums, indented 15px to align
under the label. **Count color rule:** stage color if the stage needs action
(triage), `ink` if it's a live positive stage (approved, in pursuit), and
`ink-subtle` if it's zero or terminal (with client at 0, passed).

Every column is a filter link into Matches, pre-filtered to that stage.

**Transitions.** On mount and on refresh, segments animate `flex-grow` over
`420ms cubic-bezier(0.16,1,0.3,1)`, staggered 40ms left to right. Counts tween
to their new value over 380ms — integers only, no decimals mid-tween. Hover a
column: its segment lifts to full opacity while the others drop to 0.55 over
120ms.

---

## Part 4 — PR 3: the two-column body

Below the pipeline: `grid-template-columns: 1fr 318px; gap: 16px`.

Everything must land inside one 900px viewport at 1440px wide with no scroll.
The left column and right rail are within 10px of each other in height by
design — if you change padding anywhere, re-check that they still end level.

### Left column

**Needs your attention.** Tinted header (`stage-triage` tint background, 12px
20px, bottom border `rgba(228,118,31,0.14)`): serif 16px title, round `orange`
count badge, then right-aligned `ink-subtle` 11.5px "Grant Alerts opens from
here only". Below, one row per item, `12px 20px`, `hairline` dividers, last row
none. Each row: 30px `radius-md` icon tile in the relevant stage tint, title
(14px 600) + description (12px `ink-subtle`), then a trailing affordance that
encodes urgency —

- actionable now → filled `orange` pill button, 32px, `radius-md`
- reviewable → chevron-right in `ink-faint`
- blocked → the word "Blocked" in `ink-subtle` 12px, no control

The card renders only unresolved items. **Empty state matters** — when the queue
clears, keep the card, swap the header count for a `stage-pursuit` check, and
show one centered row: "You're caught up" (14px 600) + "Next match sweep
{relative time}". Do not hide the card; a disappearing card makes the page
collapse, which is the thing we're fixing.

**Grant Report and IntellEngine** sit side by side below it: `1fr 1fr`, `gap:
16px`, `align-items: stretch`. **They must be identical width and identical
height.** IntellEngine is the shorter of the two by content — it stretches, its
content stays top-aligned, the extra space falls to the bottom of the panel.

**Grant Report** — `border-top: 3px solid stage-approved`. This is the surface
staff live in all day, so it shows real content, not just counters:
1. Header block: "STANDING WORKSPACE" label in `stage-approved`, serif 18px
   title, and three right-aligned 18px metrics (open / decided / avg fit).
2. Tinted strip (`stage-approved` tint, 7px 20px, hairlines top and bottom):
   "HIGHEST FIT RIGHT NOW" left, "Updated {n}h ago" right.
3. Three rows, `11px 20px`: 7px stage dot, title 13.5px 600 with ellipsis,
   meta "{agency} · {amount} · {stage}", then right-aligned fit score (13px
   600) over days-remaining. Days text is `orange` at ≤7 days, otherwise
   `ink-subtle`.
4. Footer `12px 20px`: "{n} more in the full report" left, "Open report" filled
   `stage-approved` pill right.

**IntellEngine** — the one surface with the AI treatment, and the only place
gradient and texture are allowed: `linear-gradient(145deg, navy 0%, navy-hover
100%)` plus a soft `orange` radial bloom top-right at 32%, clipped by
`overflow: hidden`. "AI PROPOSAL DEVELOPER" label in `orange` with a sparkles
icon, serif 18px title, one line of description at
`rgba(255,255,255,0.65)`. Below a `rgba(255,255,255,0.14)` divider: "DRAFT IN
PROGRESS", the draft title with its percent in `orange`, a 5px progress track,
then a three-item checklist (completed items get a `#4ADE80` check and 0.62
white; pending gets circle-dashed at 0.40). Footer: white "Resume draft" button
and a ghost "New draft" button with a `rgba(255,255,255,0.20)` border.

No drafts yet? Keep the panel and the treatment, replace the progress block with
one line — "No drafts yet. Start from an approved match." — and promote "New
draft" to the white primary button.

### Right rail (318px)

**Score a grant** — `border-left: 3px solid orange`. Deliberately compact: this
used to be the loudest element on the page and it is not a daily-use tool. Label
row with a `⌘/` hint chip; a 36px inset field (`surface-sunken`, `edge` border,
link icon, placeholder "Paste a NOFO link or name a program"); footer with "Fit
checked against {client}" in `ink-subtle` 11px and a 29px `orange` "Check fit"
button. `⌘/` from anywhere on the page focuses this field. Results open in an
overlay using `shadow-overlay` — the card never expands in place, because
growing it would break the column alignment.

**Upcoming deadlines** — label, then three rows with a fixed 34px left gutter
holding the day count (15px 600) over "DAYS" (9.5px 700 uppercase). Both go
`orange` at ≤7 days, otherwise the number is `ink` and the word `ink-subtle`.
Right side: title with ellipsis + "{agency} · {stage}".

**Eligibility geography** — a 76px county map image (`background-size: cover`,
`grayscale(0.5) contrast(1.05)`, with a `rgba(11,30,58,0.18)→0.72` vertical
scrim) captioned "ELIGIBILITY GEOGRAPHY" / county name in white. Below, four
data rows at `6px 0` with `hairline` dividers: rurality (RUCC), HRSA shortage
area, median household income, SAM.gov status. Qualifying values get a 6px
`stage-pursuit` dot; unresolved ones a `stage-client` dot with `#A87A1B` text.

This card is doing real work — it is the eligibility evidence we already pull
from Census / HRSA / RUCC, and it is what makes the rail read as a briefing
instead of a stack of widgets. **The 76px image height is load-bearing for the
column alignment.** If you change it, re-check that the rail and the left
column still end level.

---

## Part 5 — global motion

Nothing bounces, nothing slides in from off-screen. One easing curve for
entrances and layout, one linear curve for spinners.

- Entrance / layout: `cubic-bezier(0.16, 1, 0.3, 1)`
- Hover / press: `ease-out`
- Hover 120ms · press 80ms · panel or dropdown 140ms · number and bar tween
  380–420ms
- Card hover: shadow to `0 2px 4px rgba(11,30,58,0.06), 0 6px 14px -4px
  rgba(11,30,58,0.10)` over 140ms. No lift, no scale.
- Button press: `scale(0.985)`, 80ms.
- Skeletons pulse `opacity 1 → 0.55` over 1.4s and match the real element's
  final height, so nothing reflows when data lands.
- Honor `prefers-reduced-motion: reduce` — drop the bar and count tweens to
  final values instantly, keep opacity fades at 80ms.

## Part 6 — done means

- No layout shift between skeleton and loaded state.
- Zero scroll on the page at 1440×900. Below 1280px the rail drops under the
  left column; below 900px everything is one column and the nav collapses to a
  hamburger.
- Full keyboard path: nav → context actions → attention rows → report rows →
  rail. Visible `orange` focus ring on every interactive element.
- Every count on screen traceable to one query — the nav Matches badge, the
  pipeline triage count and the attention row all show the same number.
- No hard-coded hex left in the components you touched.
