-- ╔══════════════════════════════════════════════════════════════════════════╗
-- ║ Phase 3 — Grant Intelligence                                               ║
-- ║ Extends clients with the grant-matching profile, and reshapes grants /     ║
-- ║ review_cards to carry the IntelEngine extraction + match output.           ║
-- ╚══════════════════════════════════════════════════════════════════════════╝

-- ─── clients: grant-matching profile ─────────────────────────────────────────
-- Non-financial attributes used only by the matching engine. Readable by
-- contractors (the existing clients_select policy already allows it); the
-- financial firewall (time_entries / invoices) is untouched.
alter table clients add column if not exists rucc_codes                text;
alter table clients add column if not exists annual_budget             text;
alter table clients add column if not exists primary_funding_needs     text[];
alter table clients add column if not exists project_stage             text;
alter table clients add column if not exists match_cost_share_capacity text;
alter table clients add column if not exists federal_grant_history     text;
alter table clients add column if not exists sam_uei_status            text;
alter table clients add column if not exists known_constraints         text;

-- ─── grants: full NOFO shred ─────────────────────────────────────────────────
-- Award amounts are stored as text and explicitly flagged as estimates when the
-- NOFO does not state them, per firm policy. `deadline` (date) is a best-effort
-- parse of `submission_deadline` for the dashboard; the verified text is kept.
alter table grants drop column if exists award_min;
alter table grants drop column if exists award_max;

alter table grants add column if not exists award_range_min            text;
alter table grants add column if not exists award_range_max            text;
alter table grants add column if not exists award_range_is_estimate    boolean default true;
alter table grants add column if not exists submission_deadline        text;
alter table grants add column if not exists period_of_performance      text;
alter table grants add column if not exists scoring_rubric             jsonb;
alter table grants add column if not exists program_type               text;
alter table grants add column if not exists delivery_model             text;
alter table grants add column if not exists grant_status               text;
alter table grants add column if not exists scoring_criteria_high_value text[];
alter table grants add column if not exists technical_burden_flags     text[];
alter table grants add column if not exists incumbent_risk             text;
alter table grants add column if not exists subaward_prohibited        boolean default false;
alter table grants add column if not exists verification_flags         text[];

-- ─── review_cards: match output + reasoning ──────────────────────────────────
-- Drop the lean placeholders from 0001 in favor of the engine's exact output.
alter table review_cards drop column if exists why_fits;
alter table review_cards drop column if exists dealbreakers;
alter table review_cards drop column if exists synopsis;

alter table review_cards add column if not exists why_this_org         text[];
alter table review_cards add column if not exists concept_synopsis     text;
alter table review_cards add column if not exists description_short    text;
alter table review_cards add column if not exists draft_outreach_email text;
alter table review_cards add column if not exists outreach_track       text;
alter table review_cards add column if not exists before_you_approve   text[];
alter table review_cards add column if not exists inferred_fields      text[];
alter table review_cards add column if not exists reasoning_context    jsonb;
alter table review_cards add column if not exists hold_reason          text;

-- Decision vocabulary for the review queue: pending → approved | passed | hold.
-- The dashboard's next_deadline already keys off decision = 'approved'.

-- ─── final-approval gate (admin-only) ────────────────────────────────────────
-- Contractors can work matches (pending / passed / hold), but only an admin can
-- mark a card 'approved' — i.e. clear it to go to a client. Enforced at the DB,
-- not just the UI: a non-admin update that sets decision='approved' is blocked.
create or replace function public.guard_card_approval()
returns trigger
language plpgsql security definer set search_path = public
as $$
begin
  if new.decision = 'approved'
     and old.decision is distinct from 'approved'
     and not public.is_admin() then
    raise exception 'Only admins can approve a match for client delivery';
  end if;
  return new;
end;
$$;

drop trigger if exists review_cards_guard_approval on review_cards;
create trigger review_cards_guard_approval
  before update on review_cards
  for each row execute function public.guard_card_approval();
