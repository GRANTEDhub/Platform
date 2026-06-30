-- ════════════════════════════════════════════════════════════════════════════
-- Hard-constraints data load (step 6) + matching_rules de-duplication.
-- Source: reviewed and approved against the GOH client intake mapping.
-- 12 clients. One row per client (name is unique, index 0016).
--
-- DO NOT RUN until BOTH are true:
--   1. Migration 0018 (clients.hard_constraints jsonb) is applied to prod.
--      Without the column every UPDATE errors on hard_constraints.
--   2. The funder-vocabulary check below has confirmed the two excludes that
--      fire on the federal feed match the strings ingest actually writes.
--
-- ── Load-time funder-vocabulary check (RUN FIRST) ───────────────────────────
-- The two ineligible_funder excludes that can fire on the federal cron feed are
-- "National Endowment for the Arts" (CACHE) and "Appalachian Regional Commission"
-- (NWA Council). funderExclusionReason matches grant.funder by normalized
-- substring, so these values MUST match the real strings. Run:
--
--   select distinct funder, count(*) from grants group by funder order by funder;
--
-- If ingest writes "NEA" / "ARC" / a variant instead of the full agency name,
-- change the two values below to match real data before executing this seed.
--
-- The third ineligible_funder ("Domestic Violence Shelter Fund", EverHope /
-- Havenwood) is a known LATENT guardrail: it is a STATE program and never
-- appears on the federal Simpler.gov feed, so it cannot fire via cron. Kept
-- as-is intentionally; it is correct even while dormant. No action needed.
-- ════════════════════════════════════════════════════════════════════════════
begin;

-- 1. RROK / Dunyasi Ventures — for-profit role ceiling (Sub max)
update clients set
  hard_constraints = '[
    {"type":"role_ceiling","value":"Sub","action":"cap_role",
     "note":"For-profit (Dunyasi Ventures / Remote Ready OK). Cannot be prime or co-applicant on any federal grant. Sub / program operator is the maximum role; must sit under an eligible Lead Entity."}
  ]'::jsonb,
  matching_rules = 'Staffing commission revenue must never appear entangled with grant scope in any recommended pursuit. Flag independent evaluator requirement on all federal applications.'
where name = 'RROK / Dunyasi Ventures';

-- 2. Mississippi County — Galactic Air can never be recipient/subrecipient
update clients set
  hard_constraints = '[
    {"type":"ineligible_partner","value":"Galactic Air","action":"flag",
     "note":"Galactic Air is for-profit and cannot appear as a recipient or subrecipient on any grant for this client, under any structure."}
  ]'::jsonb,
  matching_rules = 'Do not re-pursue congressional appropriations for Building 231 or ARFF truck — exhausted. Flag any match commitment — quorum court approval required, 6-week minimum lead. Alerts must be standalone and actionable enough for Tammy to take to quorum court.'
where name = 'Mississippi County';

-- 3. Pathway to Freedom — three screens (matching_rules fully moves -> null)
update clients set
  hard_constraints = '[
    {"type":"entity_screen","value":"faith-based / Establishment Clause","action":"flag",
     "note":"Faith-based, Christ-centered, non-negotiable mission. Screen every grant for Establishment Clause and religious-activity restrictions before surfacing; do not pursue grants that restrict or hamper religious mission."},
    {"type":"entity_screen","value":"all-male beneficiary scope","action":"flag",
     "note":"All-male program. Confirm the grant does not require gender-inclusive programming before approving."},
    {"type":"entity_screen","value":"opioid-settlement (existing AG grant open)","action":"flag",
     "note":"Do not pursue new opioid-settlement grants until the existing AG opioid-settlement grant is closed out. Verify closeout status before approving."}
  ]'::jsonb,
  matching_rules = null
where name = 'Pathway to Freedom';

-- 4. UAMS NorthWest — research ceiling + NWA Council confidentiality + rural eligibility (matching_rules fully moves -> null)
update clients set
  hard_constraints = '[
    {"type":"role_ceiling","value":"Co-Applicant","scope":"research-heavy mechanisms: R34, K12, PRIMED-AI","action":"cap_role",
     "note":"On research-heavy mechanisms (R34, K12, PRIMED-AI), UAMS NorthWest is partner or regional hub under UAMS main campus, not prime."},
    {"type":"ineligible_partner","value":"NWA Council","action":"flag",
     "note":"Relationship-confidentiality: never name NWA Council in any outreach or document directed to Ryan Cork. Enforced via the same block-and-verify mechanism; not an eligibility rule."},
    {"type":"entity_screen","value":"rural eligibility (only Carroll/Boone)","action":"flag",
     "note":"Only Carroll (RUCC 6) and Boone (RUCC 7) qualify as rural. Do not use Washington County location as a rural-eligibility basis."}
  ]'::jsonb,
  matching_rules = null
where name = 'UAMS NorthWest';

-- 5. CACHE Creative — NEA exclude  (VERIFY funder string at load time)
update clients set
  hard_constraints = '[
    {"type":"ineligible_funder","value":"National Endowment for the Arts","action":"exclude",
     "note":"Never surface NEA grants. RAO classification explicitly excludes CACHE from the NEA GAP."}
  ]'::jsonb,
  matching_rules = 'WFF never appears in any client-facing grant document. Prioritize foundation grants that fund artists directly.'
where name = 'CACHE Creative';

-- 6. EverHope — AR DV Shelter Fund exclude  (LATENT: state program, never on federal feed)
update clients set
  hard_constraints = '[
    {"type":"ineligible_funder","value":"Domestic Violence Shelter Fund","action":"exclude",
     "note":"Opted out of AR domestic violence shelter licensure; ineligible for the AR Domestic Violence Shelter Fund."}
  ]'::jsonb,
  matching_rules = 'Flag any grant with match requirement >10% before surfacing. Minimum 30-day lead time required — do not alert on grants with <30 days to deadline.'
where name = 'EverHope';

-- 7. Havenwood — AR DV Shelter Fund exclude  (LATENT: state program, never on federal feed)
update clients set
  hard_constraints = '[
    {"type":"ineligible_funder","value":"Domestic Violence Shelter Fund","action":"exclude",
     "note":"Opted out of AR domestic violence shelter licensure; ineligible for the AR Domestic Violence Shelter Fund."}
  ]'::jsonb,
  matching_rules = 'Flag any grant with significant match requirement before surfacing.'
where name = 'Havenwood';

-- 8. NWA Council — ARC exclude + two program/geo screens  (VERIFY ARC funder string at load time)
update clients set
  hard_constraints = '[
    {"type":"ineligible_funder","value":"Appalachian Regional Commission","action":"exclude",
     "note":"ARC POWER: Arkansas is ineligible for ARC programs."},
    {"type":"entity_screen","value":"USDA RCDI (metro adjacency)","action":"flag",
     "note":"USDA Rural Community Development Initiative: NWA metro-adjacency exclusion. Program-level; flagged rather than funder-excluded since USDA broadly is eligible."},
    {"type":"entity_screen","value":"rural-designated program (RUCC 2)","action":"flag",
     "note":"Benton, Washington, and Madison are all RUCC 2; ineligible for rural-designated programs. Confirm the grant does not require rural designation."}
  ]'::jsonb,
  matching_rules = 'WFF never appears in any workstream-level report or client-facing document. All cross-cutting funder pursuit (WRF, J.B. Hunt, Simmons, Walmart) must be coordinated centrally before any workstream submits independently. NWAC Health past performance: none — flag on any grant where federal prime history is scored.'
where name = 'NWA Council';

-- 9. Community Clinic — rural-activity screen (matching_rules fully moves -> null)
update clients set
  hard_constraints = '[
    {"type":"entity_screen","value":"rural project activity (RUCC 2: Benton/Washington)","action":"flag",
     "note":"Benton and Washington counties are RUCC 2. Do not pursue grants requiring rural project activity (e.g., RHTP THRIVE ineligible on geography). Confirm before approving."}
  ]'::jsonb,
  matching_rules = null
where name = 'Community Clinic';

-- 10. NWACC — transportation role ceiling + Walmart COI screen
update clients set
  hard_constraints = '[
    {"type":"role_ceiling","value":"Co-Applicant","scope":"Eagle Way / transportation grants","action":"cap_role",
     "note":"On Eagle Way and transportation grants, NWACC is partner only; never the applicant or primary beneficiary."},
    {"type":"entity_screen","value":"Walmart conflict-of-interest","action":"flag",
     "note":"Flag conflict-of-interest screening for any grant where Walmart Foundation or Walmart Inc. is involved."}
  ]'::jsonb,
  matching_rules = 'All alerts and outreach route through Kim Syverson only. WFF never appears in any client-facing grant document.'
where name = 'NWACC';

-- 11. Saline County — CDBG + SS4A screens
update clients set
  hard_constraints = '[
    {"type":"entity_screen","value":"CDBG (population/income ineligible)","action":"flag",
     "note":"CDBG: ineligible by population and income profile. Program-level; flagged. Confirm before pursuing any CDBG-funded opportunity."},
    {"type":"entity_screen","value":"SS4A planning-only","action":"flag",
     "note":"SS4A eligible scope is Local Road Safety Plan development only; not implementation or master road plan update."}
  ]'::jsonb,
  matching_rules = 'Flag any TAP application for double-dip risk against prior award. Do not surface any grant where 60/40 match is required on large capital without flagging.'
where name = 'Saline County';

-- 12. WorkAbility Alliance — USDA rural until designation confirmed
update clients set
  hard_constraints = '[
    {"type":"entity_screen","value":"USDA rural programs (designation unconfirmed)","action":"flag",
     "note":"Do not pursue USDA rural programs until rural designation is confirmed (first deliverable). Verify designation status before approving."}
  ]'::jsonb,
  matching_rules = 'Building ownership at 101 Broadway: flag CDBG eligibility and USDA implications before recommending capital grants. Flex engagement — scope recommendations to match $1K engagement level.'
where name = 'WorkAbility Alliance';

-- Verify before commit: expect 12 rows, each with a populated hard_constraints.
-- select name, jsonb_array_length(hard_constraints) as n_constraints, matching_rules
-- from clients where hard_constraints is not null order by name;

commit;
