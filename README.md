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
- [ ] **Phase 3** — Grant intelligence (ingest, shred, match, review queue)
- [ ] **Phase 4** — Time tracking, invoicing
- [ ] **Phase 5** — Client intake & contract signing
- [ ] **Phase 6** — Client-facing dashboards
