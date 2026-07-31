repo: GRANTEDhub/Platform
branch: main

## Last sync
date: 2026-07-31T13:22:33Z

### Updated in this project
- Recreated the staff client dashboard (Northgate Health) pixel-for-pixel from source as a baseline.
- Proposed a tightened token system: two elevations, three radii, sans tabular figures, no photo backdrops.
- Three redesign directions for the same screen: Institutional calm, Console, Signal.

## Screen map
| Project screen | Built from |
| --- | --- |
| `Client Dashboard.dc.html` → 1a (baseline) | `app/(app)/clients/[id]/page.tsx`, `components/clients/client-dashboard.tsx`, `components/layout/hero-band.tsx`, `components/clients/check-grant.tsx`, `components/clients/client-match-chart.tsx`, `components/layout/sidebar.tsx`, `components/layout/page-backdrop.tsx`, `app/(app)/layout.tsx` |
| `Client Dashboard.dc.html` → 1b / 1c / 1d | Same screens, restyled against `lib/brand.ts`, `tailwind.config.ts`, `app/globals.css`, `components/ui/*` |
