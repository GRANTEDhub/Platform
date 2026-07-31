# Client dashboard — approved design reference

Source of truth for the client dashboard's visual design. Exported from Claude Design
(`SaaS Platform UI Design Direction`). **`Client Dashboard - Final.dc.html` is the
approved mockup** — open it in a browser (`support.js` must sit alongside it) to render
at its native 1440×900.

`Claude Code Handoff.md` carries the design intent and alignment/empty-state rules.
`github.md` records which codebase files the design was drawn against.

## Sample data is fictional

The mockup's client — "Northgate Health", Riverton County IL, and its figures — is
**invented**. This repository is public, so a real client's name and eligibility detail
does not belong in a design file, and nothing about the design depends on whose name is
in it. Keep it that way if you refresh this export: swap the sample org before
committing.

The federal program names are real public NOFO titles, which is fine — the association
between a client and a pursuit is the part that must not be real.

## Why this lives in the repo

Two prior implementation passes were driven from screenshots plus prose and drifted from
the approved design. Every value in the mockup is inline, so the file itself is the spec —
read it rather than approximating from an image.

## What is built

The whole approved design is implemented: the command band (#263), the pipeline card
(#264), the console body with the attention card, deadlines rail, Grant Report and
IntellEngine treatments (#265), and the two rail cards — Score a grant and Eligibility
geography.

**The console and the portal are separate layouts.** `ClientDashboard` is mounted by both
`app/(app)/clients/[id]/page.tsx` (`isStaff`) and `app/portal/page.tsx`
(`isStaff={false}`), and this design describes only the staff console. So `ConsoleBody` is
the design and `PortalBody` is what the portal has always shipped; the Grant Report,
IntellEngine and geography cards each take a `variant` for the same reason. Converging the
two is a deliberate decision someone should make on purpose, not a side effect of a
styling pass.

**Zero-scroll at 1440×900 is now checkable.** The geography card's 76px map tile and the
scorer's overlay-not-expand behaviour are both load-bearing for the rail ending level with
the left column. If you change either, re-check the page still fits without scrolling.

## Token authority

Where the mockup and `lib/brand.ts` disagree, **the mockup wins** and `lib/brand.ts` is
updated as the single source. In practice they already agree: `SURFACE.page` (`#F1EEE8`),
`navy`, `navyHover` (the IntellEngine gradient end), `orange`, the full `STAGE` scale and
tints, `INK`, `LINE`, `ELEVATION.card`, and all three `RADIUS` values match the mockup
exactly, as do the DM Sans / Libre Baskerville faces in `tailwind.config.ts`.

The only genuine addition is a green for the IntellEngine checklist check (`#4ADE80`),
which needs to clear contrast on the navy gradient — `BRAND.success` (`#059669`) is a
light-surface signal and is too dark there.

A handful of the mockup's inline rgba values sit within one or two hundredths of an
existing token (`rgba(11,30,58,.07)` / `.08` / `.14` against `LINE`, `#A9AFB8` against
`INK.faint`). Those snap to the existing token — the differences are sub-perceptual and
new near-duplicate tints are what the single-source rule exists to prevent.

## Where the mockup is not implementable as drawn

The mockup's numbers are sample data; the real page renders real client data. These
elements have no honest backing behind them as drawn, so the layout is matched while the
behaviour is not invented:

| Element | Resolution |
|---|---|
| Global search (`⌘K`) | Omitted. No search backend. Right-cluster spacing preserved so the band's proportions still match. |
| Notification bell | Shipped as a real control that opens and says there is no staff feed yet — an inert icon would be the same failure as the "Soon" nav links this band removed. The mockup shows no badge on it, so no count is faked. `lib/portal/notifications.ts` is client-portal-scoped and semantically wrong for a staff bell. |
| "triage window closes Aug 4" | Not shipped as drawn — no triage-window field exists, and unverified dates must not appear on a client-facing surface. The slot carries the nearest real `deadline` among the client's pipeline grants, labeled for what it is, and drops when there is none. |

Pipeline stage columns keep the mockup's spacing, widths, and type but are not clickable —
no per-stage filter route exists yet. The hover/cursor affordance is dropped so they do not
advertise themselves as links.

**"Not wired" is never a licence to change the layout.** Structure, spacing, and type scale
follow the mockup regardless of what is interactive. Both prior passes changed layout while
removing controls, which is the actual reason they read as unfaithful.
