-- ╔══════════════════════════════════════════════════════════════════════════╗
-- ║ card_intel_reviews: the on-demand IntellEngine QA verdict (Brick 1)         ║
-- ╚══════════════════════════════════════════════════════════════════════════╝
--
-- The staff-triggered QA / review pass ("Run IntellEngine Intel") writes an Opus + web-
-- verification verdict on a surfaced card. ANNOTATE-ONLY / PROPOSAL-ONLY: it never touches the
-- card's fit_score / seat / decision, so it can never remove or re-score a card. The card keeps
-- the engine's score; this carries "engine 3 → QA 1, here's the web-grounded reason", and a
-- human decides.
--
-- A SEPARATE TABLE, not a review_cards column — and that is the WHOLE point of this shape. RLS is
-- ROW-level, not column-level: 0055's `review_select` policy lets a client member SELECT their own
-- client's review_cards rows (every column). So an `intel_review` COLUMN on review_cards would be
-- readable by an authenticated portal member querying Supabase directly, even though no portal UI
-- shows it — a leak of raw internal QA voice (summary, evidence, reviewer id). This table's SELECT
-- policy is `public.is_staff()` ALONE, with NO client-member policy, so client members have no
-- policy that admits them and cannot read it at all. Mirrors the grantbot tables (0080): staff
-- SELECT only, every write service-role.
--
-- One CURRENT verdict per card (review_card_id UNIQUE, upsert on re-run). Cascade-deletes with the
-- card. NULL/absent row = no QA pass has run yet — byte-identical to today until the route + the
-- staff-only console panel ship, both of which no-op when absent. No flag; the eval (RUN_INTEL_EVAL)
-- is the "prove it" gate. Shape of intel_review jsonb: lib/grants/intel-review.ts IntelReview.

begin;

create table if not exists card_intel_reviews (
  id uuid primary key default gen_random_uuid(),
  review_card_id uuid not null unique references review_cards(id) on delete cascade,
  intel_review jsonb not null,
  created_by uuid references profiles(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table card_intel_reviews enable row level security;

-- Staff-only read. NO client-member policy (unlike review_cards) → a portal member has no policy
-- that admits them, so the raw verdict is unreachable to clients even for their own cards. NO
-- write policy → every insert/update runs service-role (the /intel route), matching 0080.
drop policy if exists card_intel_reviews_staff_select on card_intel_reviews;
create policy card_intel_reviews_staff_select on card_intel_reviews
  for select using (public.is_staff());

insert into schema_migrations (version) values ('0086_review_card_intel_review') on conflict do nothing;

commit;
