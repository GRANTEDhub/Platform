# GRANTED Platform

Internal platform for a grant consulting firm — two halves:

1. **Grant Intelligence** — ingest federal opportunities (Grants.gov /
   Simpler.grants.gov), shred NOFOs, and match against the client roster with
   Claude. Domestic-only by policy.
2. **Business Operations** — client CRM/dashboard, time tracking, invoicing
   (Stripe), and intake.

## Stack

- **Next.js 14** (App Router, TypeScript)
- **Supabase** — Postgres, Auth, Row Level Security, Storage
- **Anthropic (Claude)** — analysis engine for the grant-intelligence half
- **Stripe** — invoicing
- **Tailwind CSS** — UI
- Deploys to **Vercel**

## Access model

Two roles, enforced with Postgres RLS (not just the UI):

| Area | Admin (firm owners) | Contractor / intern |
| --- | --- | --- |
| Dashboard, Clients, Time, Invoices, Settings | ✅ | ⛔ |
| Grant Intel, Review Queue | ✅ | ✅ |

The financial tables (`time_entries`, `invoices`) have admin-only RLS policies,
so contractors cannot read or write money even if a UI guard were bypassed.
New users default to the least-privilege `contractor` role; an admin promotes
them.

## Local setup

1. `npm install`
2. Copy `.env.example` → `.env.local` and fill in Supabase + Anthropic keys.
3. In the Supabase SQL editor, run `supabase/migrations/0001_init.sql`, then
   (optionally) `supabase/seed.sql`.
4. Create your first user via the Supabase Auth dashboard, then in the SQL
   editor: `update profiles set role = 'admin' where email = 'you@grantedco.com';`
5. `npm run dev` → http://localhost:3000

## Build order

- [x] **Phase 1** — Auth, roles, RLS, app shell
- [x] **Phase 2** — Client dashboard / CRM
- [x] **Phase 3** — Grant intelligence (ingest, shred, match, review queue)
- [ ] **Phase 4** — Time tracking, invoicing
- [ ] **Phase 5** — Client intake & contract signing
- [ ] **Phase 6** — Client-facing dashboards

### Grant intelligence (Phase 3)

- **Ingest** — scheduled Vercel Cron pulls newly-posted, domestic federal
  opportunities from the Simpler.grants.gov API (`/api/cron/ingest`), or analyze
  one on demand by pasting a link / NOFO text (`/api/grants/ingest`).
- **Shred** — Claude extracts the key NOFO facts (what it funds, eligibility,
  deadline, award size, match, # of awards, scoring rubric, technical burden).
  Award amounts are labeled estimates unless the NOFO states them.
- **Match** — a JS pre-filter eliminates obvious mismatches, then Claude scores
  each client using the firm's IntelEngine logic: prime vs. partner eligibility
  kept distinct, fit score 1–3, why-it-fits, dealbreakers, draft outreach.
- **Review queue** — only score 2–3 matches surface. Anyone can work a card;
  **final approval-to-client is admin-only**, enforced by a DB trigger.

Requires `ANTHROPIC_API_KEY`, `SIMPLER_GOV_API_KEY`, and `CRON_SECRET`.
