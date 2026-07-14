-- Client profile load: 22 active clients (19 UPDATE + 3 INSERT).
--
-- Writes the approved narrative into clients.intake_data (the refiner INPUT) and
-- the structured occupancy columns (org_type, service_area, primary_funding_needs,
-- and hard_constraints where a categorical gate applies). Keeps the two separate
-- per the locked #138-140 architecture: narrative prose -> intake_data ONLY;
-- occupancy columns get structured values, never narrative prose.
--
-- intake_data is MERGED (coalesce(intake_data,'{}') || <narrative>) so non-narrative
-- keys (phone, referral_source, submitted_at, org_type_code) are never clobbered.
-- UPDATEs key on the exact client name; each should report "UPDATE 1" (a "UPDATE 0"
-- means a name mismatch to reconcile). INSERTs upsert via ON CONFLICT (name), which
-- arbitrates on the clients_name_uniq UNIQUE INDEX (migration 0016, on clients(name)),
-- so a re-run is idempotent. (It is an index, not a named constraint, so column
-- inference is used, not ON CONFLICT ON CONSTRAINT.)
--
-- priority_areas / primary_funding_needs use the real PRIORITY_AREAS enum
-- (lib/intake/fields.ts). Four batch tokens have no clean enum equivalent and were
-- dropped from the enum lists (their intent survives in funding_need/programs prose):
-- "Public Safety", "General Operating Support", "Research/R&D", "Capacity Building".
--
-- hard_constraints encode 3 gates in the real HardConstraint schema:
--   CACHE Creative       -> entity_screen  (NEA GAP reviewer screen; RAO ineligibility)
--   Mississippi County   -> ineligible_partner (Galactic Air named-entity exclusion)
--   RROK / Dunyasi       -> role_ceiling "sub" (never federal prime/co-applicant)
-- GreenLab's for-profit/nonprofit-only exclusion is NOT encoded: jsPreFilter no longer
-- gates on entity type (engine.ts) -- org_type=for_profit carries that signal to the
-- scorer -- and the schema has no entity-type exclude type, so an explicit gate would
-- be redundant/inexpressible.
--
-- Migration-first: the USER applies this in Supabase. Does NOT write client_profile
-- (that is the refiner's job -- Phase 2: run /api/clients/backfill-profiles after apply).
-- Text honors the refiner caps (mission/funding_need/partnerships/additional_info <=2000,
-- program description <=1000, serves <=300).

begin;

-- 19 UPDATEs (existing active clients, keyed on exact name)

-- Arisa Health
update clients set
  intake_data = coalesce(intake_data, '{}'::jsonb) || jsonb_build_object(
    'mission', $t$To lead with exceptional care that nurtures health and well-being for all, bringing together Arkansas' leading behavioral health providers to create the premier integrated behavioral health system, delivering whole-person care, 24/7 crisis support, and services that nurture health and hope.$t$,
    'funding_need', $t$Telehealth and remote patient monitoring for rural access, AI-assisted clinical documentation and EHR interoperability, maternal and infant behavioral health capacity, suicide prevention, care coordination and community health workers (BHAT reinstatement), SUD residential capacity, and TC2 capital infrastructure (Brinkley, Corning, Conway/Haven).$t$,
    'priority_areas', to_jsonb(array[$t$Program expansion / direct services$t$, $t$Equipment / technology$t$, $t$Capital / construction / renovation$t$, $t$Staffing / workforce$t$]::text[]),
    'programs', jsonb_build_array(
      jsonb_build_object('name', $t$Outpatient mental health services$t$, 'description', $t$Counseling, therapy, screening, psychiatric assessment and medication management, care coordination.$t$, 'serves', $t$Children and adults across 41 northern Arkansas counties$t$, 'status', $t$existing$t$),
      jsonb_build_object('name', $t$Integrated primary care$t$, 'description', $t$Chronic disease management and preventive wellness co-located with behavioral health.$t$, 'serves', $t$Ages 12+$t$, 'status', $t$existing$t$),
      jsonb_build_object('name', $t$24/7 crisis services and crisis response teams$t$, 'description', $t$Embedded MH professionals with Conway PD, Jonesboro PD, Craighead Co. Sheriff; 24/7 crisis line.$t$, 'serves', $t$Community and law enforcement partners$t$, 'status', $t$existing$t$),
      jsonb_build_object('name', $t$School-based behavioral health$t$, 'description', $t$In-school mental health services K-12.$t$, 'serves', $t$Students in partner districts$t$, 'status', $t$existing$t$),
      jsonb_build_object('name', $t$Haven (Conway)$t$, 'description', $t$12-bed QRTP for adolescent girls in foster care.$t$, 'serves', $t$Trauma-impacted foster youth 12-18$t$, 'status', $t$existing$t$),
      jsonb_build_object('name', $t$Therapeutic Communities (TC1/TC2/TC3)$t$, 'description', $t$Residential step-down for high-acuity and court-ordered adults (Act 911).$t$, 'serves', $t$Adults with serious mental illness, statewide placement$t$, 'status', $t$existing$t$),
      jsonb_build_object('name', $t$SUD residential treatment (Arisa Recovery at Mills)$t$, 'description', $t$Substance use residential care.$t$, 'serves', $t$Adults with SUD$t$, 'status', $t$existing$t$),
      jsonb_build_object('name', $t$RHTP THRIVE / PACT and Blue & You initiatives$t$, 'description', $t$Telehealth, AI-assisted documentation, maternal/infant MH clinician training, BHAT reinstatement with CHWs, first-responder resilience.$t$, 'serves', $t$Rural TC population, maternal/infant patients, first responders$t$, 'status', $t$prospective$t$),
      jsonb_build_object('name', $t$TC2 capital infrastructure$t$, 'description', $t$Capital renovation/expansion including Conway Haven to 16-bed TC2 for adult women.$t$, 'serves', $t$Court-ordered adults with SMI, adult women needing residential MH care$t$, 'status', $t$prospective$t$)
    ),
    'partnerships', $t$UAMS Institute for Community Health Innovation (RHTP evaluator); Netsmart (EHR); Bell's AI; HUML Health; Arkansas SHARE/ADH OHIT; Blue & You Foundation/Arkansas BCBS; Conway PD, Jonesboro PD, Craighead Co. Sheriff (CIT); Postpartum Support International; Ozarks Community Hospital; Mercy Hospital Berryville.$t$,
    'additional_info', $t$Formed Feb 2020 from four legacy CMHCs. Certified CCBHC, National Health Service Corps site. EIN 84-4286440, UEI EY97RELNYMH5. Operating budget ~$76.6M (FY2024 single audit; public 990 shows ~$91.8M FY2024). Context: lost state CMHC designation 7/1/26, consolidating from 26 clinics into 13 hubs due to a ~$4.4M annual state funding reduction. Advisory constraints (not hard gates): no supplanting the ended state CMHC contract, funding must add to not replace; avoid funding existing staff/positions (past Blue & You feedback); applied-services focus, not a university/research org; TC models must align with Medicaid billing for sustainability.$t$
  ),
  org_type = $t$nonprofit$t$,
  service_area = array[$t$Arkansas — 41 northern counties$t$, $t$Arkansas statewide (TC placement only)$t$]::text[],
  primary_funding_needs = array[$t$Program expansion / direct services$t$, $t$Equipment / technology$t$, $t$Capital / construction / renovation$t$, $t$Staffing / workforce$t$]::text[]
where name = $t$Arisa Health$t$;

-- Columbia County
update clients set
  intake_data = coalesce(intake_data, '{}'::jsonb) || jsonb_build_object(
    'mission', $t$County government maintaining and improving core public infrastructure and services (roads and bridges, public safety, and civic facilities) while expanding beyond its traditional state-grant funding base into federal and other sources.$t$,
    'funding_need', $t$Roads and bridges (top priority), emergency management and weather readiness, county facilities and historic preservation, fire department equipment, disaster recovery and solid waste/recycling infrastructure, and law enforcement/jail support.$t$,
    'priority_areas', to_jsonb(array[$t$Capital / construction / renovation$t$, $t$Equipment / technology$t$]::text[]),
    'programs', jsonb_build_array(
      jsonb_build_object('name', $t$Road and bridge program$t$, 'description', $t$Paving/chip-seal and multiple bridge repair/replacement projects.$t$, 'serves', $t$Countywide$t$, 'status', $t$existing$t$),
      jsonb_build_object('name', $t$Emergency management / OEM$t$, 'description', $t$Weather siren replacement, mass notification, proposed co-located emergency center (dispatch/OEM/fire).$t$, 'serves', $t$Countywide, especially rural areas$t$, 'status', $t$existing$t$),
      jsonb_build_object('name', $t$Historic courthouse preservation$t$, 'description', $t$1905 courthouse (National Register): courtroom floor, window replacement, ongoing capital improvements.$t$, 'serves', $t$County$t$, 'status', $t$existing$t$),
      jsonb_build_object('name', $t$Asbestos abatement, old annex building$t$, 'description', $t$Facility safety at 101 S. Court Square.$t$, 'serves', $t$County$t$, 'status', $t$prospective$t$)
    ),
    'partnerships', $t$Southwest Arkansas Planning & Development District; Road Management Technologies; Southern Arkansas University (limited, solid waste/recycling); local fire departments; Arkansas Game & Fish Commission (road-access grants).$t$,
    'additional_info', $t$County government, Magnolia, AR; serves Magnolia, Waldo, Emerson, McNeil, Taylor. Advisory constraints (not hard gates): prefers to avoid cash match where possible, especially for road dollars, though not an absolute barrier; LMI eligibility constraints affect some community-development/fire options; limited staff time to gather application materials before funds are exhausted.$t$
  ),
  org_type = $t$government$t$,
  service_area = array[$t$Columbia County, Arkansas$t$]::text[],
  primary_funding_needs = array[$t$Capital / construction / renovation$t$, $t$Equipment / technology$t$]::text[]
where name = $t$Columbia County$t$;

-- CACHE Creative
update clients set
  intake_data = coalesce(intake_data, '{}'::jsonb) || jsonb_build_object(
    'mission', $t$To build the capacity of the full arts, culture, and creative ecosystem of Northwest Arkansas. CACHE operates as a regional arts intermediary connecting artists and arts organizations to space, funding, and professional pathways, primarily through its facility, The Medium.$t$,
    'funding_need', $t$Revenue diversification (top priority; currently ~93% contributed revenue, targeting a shift toward 10-20% grant-funded), curriculum and resource development for nonprofit/artist professional development, organizational development and capacity building, and multi-year sustainable funding over one-off grants.$t$,
    'priority_areas', to_jsonb(array[$t$Planning / assessment$t$, $t$Program expansion / direct services$t$]::text[]),
    'programs', jsonb_build_array(
      jsonb_build_object('name', $t$The Medium$t$, 'description', $t$25,000 sq ft venue: performance, rehearsal, studio, and exhibition space.$t$, 'serves', $t$General public, renters, artists, community groups$t$, 'status', $t$existing$t$),
      jsonb_build_object('name', $t$Creative Exchange Fund (CXF)$t$, 'description', $t$Regranting program for individual artist projects (~$145K to 37 artists in 2025/26), weighted toward first-time applicants and Arkansas residents.$t$, 'serves', $t$Individual artists and artist groups$t$, 'status', $t$existing$t$),
      jsonb_build_object('name', $t$Spectra$t$, 'description', $t$Curated support for experimental and under-recognized work; indoor and outdoor awards per 2-year cycle.$t$, 'serves', $t$Visual and multidisciplinary artists, especially new to grant funding$t$, 'status', $t$existing$t$),
      jsonb_build_object('name', $t$MARs (Medium Artists in Residence)$t$, 'description', $t$Residency offering space, resources, and documentation support; 8 awards per 2-year cycle.$t$, 'serves', $t$Resident artists (cohort-based)$t$, 'status', $t$existing$t$),
      jsonb_build_object('name', $t$Professional development and convenings$t$, 'description', $t$InnerSpace lottery space access, Table Talks, CommsCon, workshops, regional leadership convenings.$t$, 'serves', $t$Artists, arts administrators, arts nonprofit leaders$t$, 'status', $t$existing$t$),
      jsonb_build_object('name', $t$Online capacity-building curriculum / regional ticketing$t$, 'description', $t$Planned online education and membership model; potential regional ticketing platform as an earned-revenue arm.$t$, 'serves', $t$Arts nonprofits regionally$t$, 'status', $t$prospective$t$)
    ),
    'partnerships', $t$Crystal Bridges and The Momentary; Art Bridges; Downtown Springdale Alliance; TheatreSquared; Latinx Theatre Project; Crowder College; Canopy NWA; Arts Live Theatre; Engage NWA. Funder relationships include Walton Family Foundation, Tyson Family Foundation, George Kaiser Family Foundation (contract services), and Arkansas Community Foundation.$t$,
    'additional_info', $t$Regional arts intermediary nonprofit, Springdale, AR (The Medium, 25,000 sq ft), 501(c)(3) confirmed, RAO (Regional Arts Organization) classification per NEA. Service area is NWA plus NE Oklahoma/Tulsa, but the OK/Tulsa geography is reachable only through the ACF/GKFF channel, not general eligibility. 77% of CACHE awards go directly to artists. Advisory (not a hard gate): prefers to avoid NEA grants generally over censorship/uncertainty concerns.$t$
  ),
  org_type = $t$nonprofit$t$,
  service_area = array[$t$Northwest Arkansas$t$, $t$NE Oklahoma / Tulsa (ACF/GKFF channel only)$t$]::text[],
  primary_funding_needs = array[$t$Planning / assessment$t$, $t$Program expansion / direct services$t$]::text[],
  hard_constraints = jsonb_build_array(jsonb_build_object('type', $t$entity_screen$t$, 'value', $t$NEA Grants for Arts Projects (GAP)$t$, 'note', $t$CACHE's RAO (Regional Arts Organization) classification categorically bars it from NEA Grants for Arts Projects (GAP). Do not pursue NEA GAP. (Schema note: encoded as a reviewer screen because GAP-ness is not a structured grant field; the broader "prefers to avoid NEA" is advisory, not gated.)$t$, 'action', $t$flag$t$))
where name = $t$CACHE Creative$t$;

-- WorkAbility Alliance
update clients set
  intake_data = coalesce(intake_data, '{}'::jsonb) || jsonb_build_object(
    'mission', $t$Create meaningful employment and workforce training for neurodivergent individuals, serving as a model employer that demonstrates the value and capability of people with disabilities.$t$,
    'funding_need', $t$Capital and construction/renovation for the Siloam Springs multi-use facility expansion (plumbing, electrical, fire suppression upgrades) and program expansion / direct services.$t$,
    'priority_areas', to_jsonb(array[$t$Capital / construction / renovation$t$, $t$Program expansion / direct services$t$]::text[]),
    'programs', jsonb_build_array(
      jsonb_build_object('name', $t$Ice cream trailer (8th Street Market, Bentonville)$t$, 'description', $t$Employs neurodivergent individuals.$t$, 'serves', $t$Neurodivergent adults$t$, 'status', $t$existing$t$),
      jsonb_build_object('name', $t$Siloam Springs brick-and-mortar multi-use facility$t$, 'description', $t$Ice cream shop plus boutique/retail booths, service offices, and food vendor space, staffed by disabled community members and volunteers. Primary funding ask.$t$, 'serves', $t$Neurodivergent adults, small businesses, community$t$, 'status', $t$prospective$t$),
      jsonb_build_object('name', $t$Job training provider under Arkansas LEARNS Act$t$, 'description', $t$Workforce and vocational training for neurodivergent teens.$t$, 'serves', $t$Neurodivergent teens$t$, 'status', $t$prospective$t$)
    ),
    'partnerships', $t$Ability Tree (Siloam Springs) — staffing, training, and community promotion partner; Open Avenues — small-business-community promotion partner.$t$,
    'additional_info', $t$Nonprofit, Bentonville, AR (expanding to Siloam Springs), 501(c)(3). No prior grant history — fully self-funded to date. No hard limits stated.$t$
  ),
  org_type = $t$nonprofit$t$,
  service_area = array[$t$Northwest Arkansas$t$, $t$Bentonville, AR$t$, $t$Siloam Springs, AR$t$]::text[],
  primary_funding_needs = array[$t$Capital / construction / renovation$t$, $t$Program expansion / direct services$t$]::text[]
where name = $t$WorkAbility Alliance$t$;

-- Community Clinic
update clients set
  intake_data = coalesce(intake_data, '{}'::jsonb) || jsonb_build_object(
    'mission', $t$Deliver exceptional, accessible, and comprehensive care through patient-focused service to the community.$t$,
    'funding_need', $t$Behavioral health workforce, women's and maternal health, chronic disease prevention, technology innovation (remote patient monitoring, digital infrastructure and IT staffing), workforce sustainability, food access and nutrition, school-based health, and capital infrastructure expansion.$t$,
    'priority_areas', to_jsonb(array[$t$Staffing / workforce$t$, $t$Program expansion / direct services$t$, $t$Equipment / technology$t$, $t$Capital / construction / renovation$t$]::text[]),
    'programs', jsonb_build_array(
      jsonb_build_object('name', $t$Comprehensive FQHC care$t$, 'description', $t$Primary/preventive care, women's and pediatric health, dental, behavioral health and MAT, rehab/sports medicine across 27+ sites (~53,000 patients/yr, incl. 11 school-based sites).$t$, 'serves', $t$Low-income and underinsured patients, significant Hispanic and Marshallese population$t$, 'status', $t$existing$t$),
      jsonb_build_object('name', $t$Behavioral Health Workforce Apprenticeship Program$t$, 'description', $t$Paid apprenticeship for bachelor-level social work graduates.$t$, 'serves', $t$Early-career behavioral health workforce$t$, 'status', $t$prospective$t$),
      jsonb_build_object('name', $t$Healthyr Remote Patient Monitoring$t$, 'description', $t$RPM platform for cardio-metabolic patients.$t$, 'serves', $t$Chronic disease patients$t$, 'status', $t$prospective$t$),
      jsonb_build_object('name', $t$Food System Integration & Nutrition Access$t$, 'description', $t$Partnerships for food access and nutrition education.$t$, 'serves', $t$Hispanic and Marshallese patient populations$t$, 'status', $t$existing$t$)
    ),
    'partnerships', $t$Potter's House (CHW/nurse navigator site); University of Arkansas (IQR convening); Market Center of the Ozarks; Arkansas Food Innovation Center; Hartland Whole Health Institute; UA Extension; Canopy; local school districts; state-program access routed through Susanna/Anchor (AORP, ARAG, RHT, Public Health Local Grant Trust Fund).$t$,
    'additional_info', $t$Nonprofit Federally Qualified Health Center (FQHC), Springdale, AR, serving Benton and Washington Counties across 27+ sites, 501(c)(3) (confirmed). Owned by St. Francis House NWA Inc. (public IRS records list this EIN under that name — confirm correct grant applicant entity if a federal submission requires it). Advisory constraints (not hard gates): program sustainability must include a reimbursement pathway (Medicaid/Medicare, CHW/RPM billing); prefers no/low-match grants or in-kind; generally avoids grants under $10,000.$t$
  ),
  org_type = $t$nonprofit$t$,
  service_area = array[$t$Benton County, Arkansas$t$, $t$Washington County, Arkansas$t$]::text[],
  primary_funding_needs = array[$t$Staffing / workforce$t$, $t$Program expansion / direct services$t$, $t$Equipment / technology$t$, $t$Capital / construction / renovation$t$]::text[]
where name = $t$Community Clinic$t$;

-- EverHope
update clients set
  intake_data = coalesce(intake_data, '{}'::jsonb) || jsonb_build_object(
    'mission', $t$Provide comprehensive, trauma-informed care to youth and families in crisis, often serving as a child's first safe placement upon entering care.$t$,
    'funding_need', $t$General operating support (top need), HVAC replacement, a 12-passenger van, security and anti-trafficking upgrades, and nutrition cost offsets.$t$,
    'priority_areas', to_jsonb(array[$t$Equipment / technology$t$, $t$Capital / construction / renovation$t$]::text[]),
    'programs', jsonb_build_array(
      jsonb_build_object('name', $t$90-day emergency shelter$t$, 'description', $t$Trauma-informed stabilization and care.$t$, 'serves', $t$Youth in crisis statewide (~27% from NWA)$t$, 'status', $t$existing$t$),
      jsonb_build_object('name', $t$On-site trauma-informed school$t$, 'description', $t$Academic continuity during shelter stay (Bentonville School District partnership).$t$, 'serves', $t$Sheltered youth$t$, 'status', $t$existing$t$),
      jsonb_build_object('name', $t$Foster home licensing & support$t$, 'description', $t$DHS liaison, caregiver resources and advocacy.$t$, 'serves', $t$NWA foster families$t$, 'status', $t$existing$t$),
      jsonb_build_object('name', $t$Hope School Project$t$, 'description', $t$Trauma-informed intervention in a school setting (off-site, Springdale ALE K-8).$t$, 'serves', $t$At-risk youth$t$, 'status', $t$existing$t$),
      jsonb_build_object('name', $t$Pathways to Adulthood$t$, 'description', $t$Housing, stability, and support for youth aging out of foster care.$t$, 'serves', $t$Aging-out foster youth$t$, 'status', $t$prospective$t$)
    ),
    'partnerships', $t$Bentonville Public School District; Springdale Public School District; Arkansas DHS (foster licensing liaison).$t$,
    'additional_info', $t$Nonprofit (formerly NWA Children's Shelter), Bentonville, AR, 501(c)(3). Service area is statewide Arkansas (shelter/school) with foster licensing across NWA. Advisory constraints (not hard gates): statewide service area (only ~27% of youth from NWA) may affect fit for regionally restricted funders; ~1 month application lead time plus advance notice for board-signature requirements; grants lead is new to the role.$t$
  ),
  org_type = $t$nonprofit$t$,
  service_area = array[$t$Arkansas statewide (shelter/school)$t$, $t$Northwest Arkansas (foster licensing)$t$]::text[],
  primary_funding_needs = array[$t$Equipment / technology$t$, $t$Capital / construction / renovation$t$]::text[]
where name = $t$EverHope$t$;

-- Harbor House
update clients set
  intake_data = coalesce(intake_data, '{}'::jsonb) || jsonb_build_object(
    'mission', $t$Provide hope and healing for people with addiction through multiple pathways of care, from detox through residential treatment into transitional living.$t$,
    'funding_need', $t$Capital expansion and brick-and-mortar (primary need: transitional living bed growth from 124 to 200+), infrastructure and enhanced treatment facilities, Northwest Arkansas geographic expansion, and transportation (vehicle funding).$t$,
    'priority_areas', to_jsonb(array[$t$Capital / construction / renovation$t$, $t$Program expansion / direct services$t$]::text[]),
    'programs', jsonb_build_array(
      jsonb_build_object('name', $t$Observational Detox$t$, 'description', $t$Entry-point stabilization for individuals beginning recovery.$t$, 'serves', $t$Adults entering treatment$t$, 'status', $t$existing$t$),
      jsonb_build_object('name', $t$Residential Treatment$t$, 'description', $t$Gender-specific 30-, 60-, and 90-day treatment programs.$t$, 'serves', $t$Men and women with substance use disorder$t$, 'status', $t$existing$t$),
      jsonb_build_object('name', $t$Specialized Women's Services$t$, 'description', $t$Treatment combined with parenting and household-management supports.$t$, 'serves', $t$Pregnant women and mothers with small children$t$, 'status', $t$existing$t$),
      jsonb_build_object('name', $t$Outpatient Treatment$t$, 'description', $t$Less intensive track for clients maintaining work/school/family responsibilities.$t$, 'serves', $t$Adults not requiring residential care$t$, 'status', $t$existing$t$),
      jsonb_build_object('name', $t$Transitional Living$t$, 'description', $t$Recovery housing after residential treatment; currently 124 beds, need is 200+.$t$, 'serves', $t$Men, women, Specialized Women's Services participants (Fort Smith and Hot Springs)$t$, 'status', $t$existing$t$),
      jsonb_build_object('name', $t$Supplemental Recovery Supports$t$, 'description', $t$Aftercare, parenting classes, anger management, DWI/DUI services, smoking cessation, gambling services.$t$, 'serves', $t$Clients across all program tracks$t$, 'status', $t$existing$t$)
    ),
    'partnerships', $t$United Way of Fort Smith; Washington/Madison County Drug Court (justice-involved referrals); Paula Stone/OSAMH (state contracts); Center for Nonprofits Fort Smith (grant vendor); Rural Health Association of Arkansas; congressional appropriations lobbyists (Capitol Consulting).$t$,
    'additional_info', $t$Nonprofit behavioral health/addiction treatment provider, Fort Smith, AR (with Hot Springs presence), 501(c)(3). Public 990 revenue ~$11.2M FY2024. Advisory constraints (not hard gates): capital only, not seeking funding for payroll or routine operations; stays focused on adult substance use treatment, not broadening into unrelated service models; federal competitive grants require multi-month lead time and pre-positioning; Walker Foundation has a 30-day pre-contact rule; Tyson Foundation requires plant-level contact or chaplain vouch before pursuing.$t$
  ),
  org_type = $t$nonprofit$t$,
  service_area = array[$t$Fort Smith, Arkansas$t$, $t$Hot Springs, Arkansas$t$, $t$Northwest Arkansas (expansion)$t$]::text[],
  primary_funding_needs = array[$t$Capital / construction / renovation$t$, $t$Program expansion / direct services$t$]::text[]
where name = $t$Harbor House$t$;

-- Havenwood
update clients set
  intake_data = coalesce(intake_data, '{}'::jsonb) || jsonb_build_object(
    'mission', $t$Empower single mothers and their children to move from crisis to self-sufficiency.$t$,
    'funding_need', $t$Unrestricted operational support (top priority), therapist program support, a phased security system, legal assistance, housing expansion, and charity event sponsorships.$t$,
    'priority_areas', to_jsonb(array[$t$Program expansion / direct services$t$, $t$Capital / construction / renovation$t$]::text[]),
    'programs', jsonb_build_array(
      jsonb_build_object('name', $t$Two-year transitional housing program$t$, 'description', $t$14 furnished apartments in a 10,560 sq ft facility.$t$, 'serves', $t$Single mothers with up to 2 children$t$, 'status', $t$existing$t$),
      jsonb_build_object('name', $t$Case management$t$, 'description', $t$Includes TBRA housing navigation, financial planning, and career coaching.$t$, 'serves', $t$Program residents$t$, 'status', $t$existing$t$),
      jsonb_build_object('name', $t$Life skills / financial literacy workshops$t$, 'description', $t$Budgeting, job readiness, parenting.$t$, 'serves', $t$Program residents$t$, 'status', $t$existing$t$),
      jsonb_build_object('name', $t$Pantry / basic needs support$t$, 'description', $t$Food pantry, donation closets, laundry.$t$, 'serves', $t$Program residents$t$, 'status', $t$existing$t$),
      jsonb_build_object('name', $t$Counseling / therapeutic services$t$, 'description', $t$On-site, via Pathways partnership.$t$, 'serves', $t$Program residents$t$, 'status', $t$existing$t$)
    ),
    'partnerships', $t$Pathways (on-site counseling/therapy); University of Arkansas & NWACC (informal referral/education support); UpSkill (medical-field referrals); Community Development of NWA (landlord); Restore Hope; Benchmark Group (pro bono architectural support).$t$,
    'additional_info', $t$Standalone nonprofit, Bentonville, AR, 501(c)(3), serving Northwest Arkansas. Advisory constraints (not hard gates): has deliberately not pursued Arkansas DV shelter licensure (excludes it from the state's DV Shelter Fund); can house mothers with up to 2 children only, cannot safely house teens; cautious about public funding after prior mission-drift/audit concerns with pass-through grants; board expects visible new grant revenue.$t$
  ),
  org_type = $t$nonprofit$t$,
  service_area = array[$t$Northwest Arkansas$t$, $t$Bentonville, AR$t$]::text[],
  primary_funding_needs = array[$t$Program expansion / direct services$t$, $t$Capital / construction / renovation$t$]::text[]
where name = $t$Havenwood$t$;

-- NWA Council
update clients set
  intake_data = coalesce(intake_data, '{}'::jsonb) || jsonb_build_object(
    'mission', $t$Regional leadership organization advancing economic opportunity, workforce development, infrastructure, health care, and quality of life across Benton and Washington Counties by convening business, government, health, and education sectors around shared regional priorities.$t$,
    'funding_need', $t$Workforce housing affordability (Groundwork), startup/entrepreneurial ecosystem support (StartupNWA), establishment of the NWA Industrial & Technology Authority (InvestNWA), specialty care access and GME expansion (Health), youth leadership and newcomer welcome (EngageNWA), water/wastewater capacity and recycling and public safety tech (Infrastructure), and employer outreach and career coaching (CareersNWA).$t$,
    'priority_areas', to_jsonb(array[$t$Program expansion / direct services$t$, $t$Planning / assessment$t$, $t$Staffing / workforce$t$, $t$Capital / construction / renovation$t$]::text[]),
    'programs', jsonb_build_array(
      jsonb_build_object('name', $t$Groundwork NWA (Workforce Housing)$t$, 'description', $t$Housing affordability strategy and policy advocacy, Growing Home NWA regional plan, planned housing fund.$t$, 'serves', $t$Working families, renters, homebuyers in NWA; expanding statewide$t$, 'status', $t$existing$t$),
      jsonb_build_object('name', $t$StartupNWA / Onward HQ (Entrepreneurship)$t$, 'description', $t$Startup ecosystem hub, founder-investor programming, VC immersions, coworking space.$t$, 'serves', $t$Early-stage founders and investors in NWA$t$, 'status', $t$existing$t$),
      jsonb_build_object('name', $t$InvestNWA (Economic Development)$t$, 'description', $t$Business attraction and site selection; standing up the NWA Industrial & Technology Authority to solve a real estate gap.$t$, 'serves', $t$Employers and the regional economic base$t$, 'status', $t$existing$t$),
      jsonb_build_object('name', $t$NWA Council Health / Health Care Transformation$t$, 'description', $t$Vision 2030 roadmap: value-based payment/health policy reform, specialty care access, GME expansion, health research ecosystem.$t$, 'serves', $t$NWA residents/patients and regional health systems$t$, 'status', $t$existing$t$),
      jsonb_build_object('name', $t$EngageNWA (Belonging & Bridging)$t$, 'description', $t$Social cohesion and inclusion: Welcoming Week, youth leadership, newcomer program.$t$, 'serves', $t$NWA residents including newcomers/immigrants and youth$t$, 'status', $t$existing$t$),
      jsonb_build_object('name', $t$NWA Council Infrastructure & Policy$t$, 'description', $t$Regional coordination on water/wastewater capacity, recycling expansion, public safety tech, multi-jurisdictional growth alignment.$t$, 'serves', $t$NWA's 24 cities and 2-3 counties (convener role)$t$, 'status', $t$existing$t$),
      jsonb_build_object('name', $t$CareersNWA (Life Works Here)$t$, 'description', $t$Talent attraction, relocation, retention; employer outreach team, career coaches, career pathways.$t$, 'serves', $t$Job seekers and workers in or relocating to NWA; employers$t$, 'status', $t$existing$t$)
    ),
    'partnerships', $t$Anchor corporate/founding members and philanthropic funders (Arnold Ventures, Winthrop Rockefeller Foundation, Blue & You Foundation); public-sector (NWARPC, NWAEDD, XNA Airport, Arkansas EDC); education (University of Arkansas, NWACC); health systems (Washington Regional, Arisa Health, Community Clinic NWA, UAMS Northwest, Heartland Whole Health Institute, Alice L. Walton School of Medicine); Growing Home NWA planning team.$t$,
    'additional_info', $t$Regional leadership org (est. 1990), Bentonville/Springdale corridor, serving primarily Benton & Washington Counties with select statewide exceptions. Current President & CEO: Nelson Peacock. Entity structure: the NWA Council is a 501(c)(6) business league; its affiliated 501(c)(3), NWA Council Foundation (EIN 46-0807914), serves as grant applicant of record. Per GRANTED direction, treat Council and Foundation as the same applicant for matching purposes and resolve the specific prime/applicant entity per grant. Advisory context (not a hard gate): the Council role is often convener/facilitator rather than direct-service prime, and requires a public-sector or clinical prime on infrastructure/housing-construction/clinical health grants; high-income fast-growing metro profile can exclude programs targeting distressed/rural/low-income areas; per standing GRANTED instruction, Walton Family Foundation, Walmart Foundation, Tyson Family Foundation, Simmons Foods Foundation, and J.B. & Johnelle Hunt Family Foundation are excluded from workstream-level opportunity lists (Hunt permitted only on the Cross-Cutting list, December cycle).$t$
  ),
  org_type = $t$nonprofit$t$,
  service_area = array[$t$Benton County, Arkansas$t$, $t$Washington County, Arkansas$t$, $t$Arkansas statewide (select programs)$t$]::text[],
  primary_funding_needs = array[$t$Program expansion / direct services$t$, $t$Planning / assessment$t$, $t$Staffing / workforce$t$, $t$Capital / construction / renovation$t$]::text[]
where name = $t$NWA Council$t$;

-- NWACC
update clients set
  intake_data = coalesce(intake_data, '{}'::jsonb) || jsonb_build_object(
    'mission', $t$Empower lives, inspire learning, and strengthen the community through accessible, affordable, quality education.$t$,
    'funding_need', $t$Workforce development and CTE innovation, equipment and instructional technology (robotics, advanced manufacturing), student support services, generative AI and data infrastructure, campus infrastructure and facilities, and STEM and healthcare training pipelines.$t$,
    'priority_areas', to_jsonb(array[$t$Staffing / workforce$t$, $t$Equipment / technology$t$, $t$Program expansion / direct services$t$, $t$Capital / construction / renovation$t$]::text[]),
    'programs', jsonb_build_array(
      jsonb_build_object('name', $t$CCAMPIS / SUCCESS Program$t$, 'description', $t$Subsidized childcare plus wraparound support for student-parents via HWCEC.$t$, 'serves', $t$NWACC student-parents$t$, 'status', $t$existing$t$),
      jsonb_build_object('name', $t$NWACC/UpSkill Nursing Pipeline$t$, 'description', $t$Tuition coverage plus wraparound support for nursing students with a 2-year regional employment commitment.$t$, 'serves', $t$Economically disadvantaged adult students (166 enrolled)$t$, 'status', $t$existing$t$),
      jsonb_build_object('name', $t$Biotechnology Program / NAABI$t$, 'description', $t$Certificate/AAS pathways in biotechnology with UofA and industry partners (launched Fall 2024).$t$, 'serves', $t$Technical/CTE students$t$, 'status', $t$existing$t$),
      jsonb_build_object('name', $t$Workforce Development / Career-Aligned Training$t$, 'description', $t$Short-term credentialing in healthcare, manufacturing, IT, business.$t$, 'serves', $t$Adult and non-traditional learners, employers$t$, 'status', $t$existing$t$),
      jsonb_build_object('name', $t$Advanced Manufacturing — Robotics Equipment$t$, 'description', $t$Robotic equipment acquisition for manufacturing training.$t$, 'serves', $t$Technical/CTE students$t$, 'status', $t$prospective$t$),
      jsonb_build_object('name', $t$Student Support Systems$t$, 'description', $t$Mental health, transportation, food security, childcare.$t$, 'serves', $t$NWACC students broadly$t$, 'status', $t$existing$t$)
    ),
    'partnerships', $t$HWCEC (CCAMPIS); UpSkill of NWA (multi-year); City of Bentonville; Walmart and regional employers; University of Arkansas (Biotechnology/NAABI).$t$,
    'additional_info', $t$Public two-year community college, Bentonville, AR (Benton County and surrounding NWA region). Advisory constraints (not hard gates): not research-heavy, avoid highly technical/university-based research grants unless applied/workforce-relevant; per May 2025 client direction, avoid private philanthropic and pure-research opportunities and outside-partner collaborations beyond existing relationships; standing flag — on the Eagle Way Tunnel & Trail, NWACC is partner/beneficiary only. A separate NWACC Foundation (EIN 71-0697377) is a 501(c)(3) that can serve as applicant for philanthropic funding.$t$
  ),
  org_type = $t$government$t$,
  service_area = array[$t$Benton County, Arkansas$t$, $t$Northwest Arkansas region$t$]::text[],
  primary_funding_needs = array[$t$Staffing / workforce$t$, $t$Equipment / technology$t$, $t$Program expansion / direct services$t$, $t$Capital / construction / renovation$t$]::text[]
where name = $t$NWACC$t$;

-- Faulkner County
update clients set
  intake_data = coalesce(intake_data, '{}'::jsonb) || jsonb_build_object(
    'mission', $t$County government providing public safety, justice, infrastructure, cultural preservation, and community support for Conway and surrounding rural communities.$t$,
    'funding_need', $t$Historic records digitization, facility restoration and modernization, fire protection strategy and FEMA equipment, veteran services, road/bridge/transportation safety, and emergency preparedness and resilience.$t$,
    'priority_areas', to_jsonb(array[$t$Capital / construction / renovation$t$, $t$Equipment / technology$t$]::text[]),
    'programs', jsonb_build_array(
      jsonb_build_object('name', $t$Historic records preservation/digitization$t$, 'description', $t$Marriage and probate books; legal/cultural continuity.$t$, 'serves', $t$County$t$, 'status', $t$prospective$t$),
      jsonb_build_object('name', $t$County facility restoration$t$, 'description', $t$Courthouse, museum, emergency squad facilities modernization.$t$, 'serves', $t$County$t$, 'status', $t$existing$t$),
      jsonb_build_object('name', $t$Fire protection / unified fire strategy$t$, 'description', $t$Public safety strategy plus FEMA equipment pursuit.$t$, 'serves', $t$County fire departments$t$, 'status', $t$existing$t$),
      jsonb_build_object('name', $t$Veteran Services Office expansion$t$, 'description', $t$Staffing and resources expansion.$t$, 'serves', $t$Veterans$t$, 'status', $t$prospective$t$),
      jsonb_build_object('name', $t$Conway Loop / Baker Wills road project$t$, 'description', $t$BUILD planning grant, Phase One; 18-wheeler bypass route.$t$, 'serves', $t$Conway and surrounding areas$t$, 'status', $t$prospective$t$)
    ),
    'partnerships', $t$OEM/FEMA; Metroplan; ARDOT; City of Conway; Conway Corp; Garver (engineering); GRANTED (grant admin support).$t$,
    'additional_info', $t$County government, Conway, AR (Central Arkansas). Arkansas county structure: the County Judge is the chief executive; Quorum Court approval gates all expenditures and match commitments. Advisory constraints (not hard gates): limited internal grant-management capacity; matching-fund constraints on large capital projects; resistance among independent volunteer fire departments to consolidation; ARPA flexibility largely exhausted; must avoid double-dipping across grants; coordination with Metroplan required to avoid conflicts of interest.$t$
  ),
  org_type = $t$government$t$,
  service_area = array[$t$Faulkner County, Arkansas$t$]::text[],
  primary_funding_needs = array[$t$Capital / construction / renovation$t$, $t$Equipment / technology$t$]::text[]
where name = $t$Faulkner County$t$;

-- Greene County
update clients set
  intake_data = coalesce(intake_data, '{}'::jsonb) || jsonb_build_object(
    'mission', $t$Deliver core public services (roads, bridges, emergency response, land use, and general government operations) with a focus on resilient infrastructure, public safety, and long-term community development across highly rural and small-town areas.$t$,
    'funding_need', $t$Bridge and infrastructure rehabilitation (highest priority), courthouse restoration and expansion, local health unit renovation, rural fire/water/sewer improvements, library relocation and downtown revitalization, juvenile services reform, and CDBG non-entitlement capital.$t$,
    'priority_areas', to_jsonb(array[$t$Capital / construction / renovation$t$, $t$Planning / assessment$t$]::text[]),
    'programs', jsonb_build_array(
      jsonb_build_object('name', $t$Bridge & Infrastructure Rehabilitation$t$, 'description', $t$Repair/rebuild of erosion-damaged county bridges (~$2.5M need, worsened by April 2025 flooding); lead project CR 523 full replacement tied to ARDOT lane-widening.$t$, 'serves', $t$County road/bridge users countywide$t$, 'status', $t$existing$t$),
      jsonb_build_object('name', $t$Historic Courthouse Restoration & Adaptive Use$t$, 'description', $t$Restoration of the 1888 courthouse for reuse as County Judge's office and HR; LOI accepted.$t$, 'serves', $t$County government operations, downtown Paragould$t$, 'status', $t$existing$t$),
      jsonb_build_object('name', $t$Courthouse Expansion$t$, 'description', $t$New ~$3.5M east-side district courtroom addition, sally port, office/storage; City of Paragould willing to co-fund.$t$, 'serves', $t$County judicial operations$t$, 'status', $t$prospective$t$),
      jsonb_build_object('name', $t$Local Health Unit Renovation$t$, 'description', $t$Interior renovation (~$500K) of the county-owned health department building; City of Paragould as CDBG applicant of record, county as beneficiary.$t$, 'serves', $t$Health unit staff and clients in Paragould$t$, 'status', $t$prospective$t$),
      jsonb_build_object('name', $t$Rural Community Improvements$t$, 'description', $t$Fire protection, water/sewer overhaul, facility upgrades in towns under 3,000 residents.$t$, 'serves', $t$Delaplaine, Lafe, Oak Grove Heights residents$t$, 'status', $t$existing$t$),
      jsonb_build_object('name', $t$Library Relocation & Downtown Revitalization$t$, 'description', $t$3-5 year plan for a new downtown library, freeing the current site for museum/historical/veterans use.$t$, 'serves', $t$Paragould residents, historic district$t$, 'status', $t$prospective$t$),
      jsonb_build_object('name', $t$CDBG Non-Entitlement Pursuit$t$, 'description', $t$First-time pursuit of annual CDBG capital funding via AEDC; targeting FY27.$t$, 'serves', $t$LMI-eligible areas countywide$t$, 'status', $t$prospective$t$)
    ),
    'partnerships', $t$East Arkansas Planning & Development District (Judge McMillon is Vice President); Clay County (joint applicant, Marine Fuel Tax); City of Paragould (shared econ dev commission, courthouse expansion co-funding, CDBG applicant of record for health unit); Arkansas Game & Fish (Marine Fuel Tax alignment); Arkansas Community Foundation (Greene Co. Giving Tree affiliate).$t$,
    'additional_info', $t$County government, Paragould, AR (Paragould, Marmaduke, Lafe, Delaplaine, Oak Grove Heights, Walcott). 1888 courthouse undergoing preservation (National Register status not confirmed — verify before citing). Arkansas county structure: County Judge is chief executive; Quorum Court approval gates all expenditures and match commitments. Note: several FY27 pursuits (SS4A, FEMA BRIC, ARCAG, USDA ELRP) are sourced from a July 2026 client brief and not yet corroborated in Drive strategy docs — verify status before acting.$t$
  ),
  org_type = $t$government$t$,
  service_area = array[$t$Greene County, Arkansas$t$]::text[],
  primary_funding_needs = array[$t$Capital / construction / renovation$t$, $t$Planning / assessment$t$]::text[]
where name = $t$Greene County$t$;

-- Mississippi County
update clients set
  intake_data = coalesce(intake_data, '{}'::jsonb) || jsonb_build_object(
    'mission', $t$A Delta-region county government serving Blytheville, Osceola, and 17 other incorporated communities, committed to strengthening infrastructure, expanding economic opportunity, and advancing workforce development while honoring its Delta heritage.$t$,
    'funding_need', $t$Arkansas Aeroplex redevelopment (facility renovation, equipment, industrial site development), landfill and solid waste infrastructure, aviation workforce development, ARFF/public safety equipment, heritage/tourism capital (Cold War Center), and wildfire aviation readiness infrastructure.$t$,
    'priority_areas', to_jsonb(array[$t$Capital / construction / renovation$t$, $t$Equipment / technology$t$, $t$Staffing / workforce$t$]::text[]),
    'programs', jsonb_build_array(
      jsonb_build_object('name', $t$Arkansas Aeroplex Redevelopment$t$, 'description', $t$Adaptive reuse of former Eaker AFB: Building 231 (~$2-3M), hangar (~$15M), shovel-ready industrial sites tied to $1M AEDC funding.$t$, 'serves', $t$County residents, industry tenants (steel, aerospace, logistics)$t$, 'status', $t$existing$t$),
      jsonb_build_object('name', $t$National Cold War Center$t$, 'description', $t$$70M heritage/tourism capital project at the former alert facility (separate funding track).$t$, 'serves', $t$Visitors, regional tourism economy$t$, 'status', $t$prospective$t$),
      jsonb_build_object('name', $t$Landfill Infrastructure Program$t$, 'description', $t$Two new landfill cells (~$4.3M), countywide recycling hub (~$2M), truck transfer building (~$4.5M).$t$, 'serves', $t$County residents, RSWMD service area$t$, 'status', $t$existing$t$),
      jsonb_build_object('name', $t$Aviation Workforce Development$t$, 'description', $t$FAA/DOL-funded aviation maintenance and pilot training via Arkansas Northeastern College.$t$, 'serves', $t$Regional workforce, ANC students$t$, 'status', $t$existing$t$),
      jsonb_build_object('name', $t$Entrepreneur Leadership Academy$t$, 'description', $t$USDA RBDG-funded entrepreneur training, technical assistance, small business showcase.$t$, 'serves', $t$Aspiring/existing small business owners countywide$t$, 'status', $t$existing$t$),
      jsonb_build_object('name', $t$ARFF Fire/Rescue Vehicle Replacement$t$, 'description', $t$Oshkosh Striker ARFF truck for Blytheville-Gosnell Regional Airport Authority.$t$, 'serves', $t$Airport fire/rescue coverage$t$, 'status', $t$existing$t$)
    ),
    'partnerships', $t$Arkansas Northeastern College; Great River Economic Development Foundation; Garver LLC; Blytheville-Gosnell Regional Airport Authority; City of Blytheville; AEDC; Congressman Crawford's and Congressman Westerman's offices; East Arkansas Planning & Development District.$t$,
    'additional_info', $t$County government, Delta region, AR (Blytheville/Osceola, 19 incorporated communities). Arkansas county structure: County Judge is chief executive; Quorum Court must approve any matching-fund commitment before application (flag deadlines at least 6 weeks in advance). Advisory constraints (not hard gates): limited capacity for match/cost-share, prioritize no/low-match programs and flag match requirements explicitly. The hospital-system modernization workstream (NYITCOM residency) is flagged inactive as of June 2026 — hold until re-raised by client. Note: private-runway/AIP point (FAA public-use airport grants not viable) is a real eligibility fact but grant-specific and left advisory.$t$
  ),
  org_type = $t$government$t$,
  service_area = array[$t$Mississippi County, Arkansas$t$]::text[],
  primary_funding_needs = array[$t$Capital / construction / renovation$t$, $t$Equipment / technology$t$, $t$Staffing / workforce$t$]::text[],
  hard_constraints = jsonb_build_array(jsonb_build_object('type', $t$ineligible_partner$t$, 'value', $t$Galactic Air$t$, 'note', $t$Galactic Air (for-profit tenant / named industry partner) may never be named as a recipient or subrecipient on any federal application; tenant only, never co-applicant. Standing compliance hard line.$t$, 'action', $t$flag$t$))
where name = $t$Mississippi County$t$;

-- Pope County
update clients set
  intake_data = coalesce(intake_data, '{}'::jsonb) || jsonb_build_object(
    'mission', $t$Strengthen essential government functions, public safety infrastructure, and emergency management capabilities via brick-and-mortar investment and strategic grants, prioritizing fiscal responsibility and long-term community resilience.$t$,
    'funding_need', $t$Cybersecurity, 911 modernization, public safety and emergency response equipment, bridge construction, a Cooperative Extension facility, a senior center, airport development, and nuclear safety improvements.$t$,
    'priority_areas', to_jsonb(array[$t$Equipment / technology$t$, $t$Capital / construction / renovation$t$]::text[]),
    'programs', jsonb_build_array(
      jsonb_build_object('name', $t$911 modernization$t$, 'description', $t$Cloud-based network and underground building repair for emergency dispatch.$t$, 'serves', $t$Countywide$t$, 'status', $t$existing$t$),
      jsonb_build_object('name', $t$Drone procurement & mobile command post$t$, 'description', $t$Disaster/emergency response capability.$t$, 'serves', $t$Countywide$t$, 'status', $t$prospective$t$),
      jsonb_build_object('name', $t$Bridge replacement/construction$t$, 'description', $t$Transportation safety on rural routes.$t$, 'serves', $t$Rural routes$t$, 'status', $t$existing$t$),
      jsonb_build_object('name', $t$Cooperative Extension facility build$t$, 'description', $t$Educational/community services facility (land secured).$t$, 'serves', $t$County$t$, 'status', $t$prospective$t$),
      jsonb_build_object('name', $t$Senior center / airport expansion$t$, 'description', $t$Community and economic development (500-600 acre site, 10,000 ft runway).$t$, 'serves', $t$Russellville area$t$, 'status', $t$prospective$t$)
    ),
    'partnerships', $t$West Central Planning & Development District; Arkansas Dept. of Emergency Management; FEMA; ARDOT; AEDC; Entergy (nuclear-adjacent preparedness); River Valley Alliance for Economic Development; Cooperative Extension; Area Agency on Aging; City of Russellville.$t$,
    'additional_info', $t$County government, Russellville, AR. Arkansas county structure: County Judge is chief executive; Quorum Court approval gates expenditures and match. Advisory constraints (not hard gates): no dedicated county sales tax since 1995, limiting capital funds; demographic undercount (~82K estimated vs ~64K census) reduces formula funding; LMI qualification gaps restrict some federal/state rural programs; lean administrative capacity requires external grant support.$t$
  ),
  org_type = $t$government$t$,
  service_area = array[$t$Pope County, Arkansas$t$]::text[],
  primary_funding_needs = array[$t$Equipment / technology$t$, $t$Capital / construction / renovation$t$]::text[]
where name = $t$Pope County$t$;

-- Saline County
update clients set
  intake_data = coalesce(intake_data, '{}'::jsonb) || jsonb_build_object(
    'mission', $t$County government serving roughly 125,000-130,000 residents in central Arkansas, providing infrastructure, public safety, and community services within Metroplan's MPO jurisdiction and the CAPDD planning district.$t$,
    'funding_need', $t$Southwest Trail (primary), intersection improvements, bridge replacement, public safety (jail HVAC, fire departments, sheriff), flood mitigation/drainage, rodeo arena/fairgrounds reconstruction, tornado siren repair, river access/recreation, and litter abatement.$t$,
    'priority_areas', to_jsonb(array[$t$Capital / construction / renovation$t$, $t$Program expansion / direct services$t$]::text[]),
    'programs', jsonb_build_array(
      jsonb_build_object('name', $t$Southwest Trail$t$, 'description', $t$65-mile regional multi-use trail, 26 miles through Saline County (~15% built); ROW acquisition, design, construction.$t$, 'serves', $t$General public, recreational users$t$, 'status', $t$existing$t$),
      jsonb_build_object('name', $t$Intersection Improvements (Hwy 5/De Soto)$t$, 'description', $t$Design/construction of a state highway/county road intersection safety upgrade.$t$, 'serves', $t$Motorists, county residents$t$, 'status', $t$existing$t$),
      jsonb_build_object('name', $t$Bridge Replacement$t$, 'description', $t$Local bridge repair/replacement across the county road system (Quapaw, Danville, Samples Road, Cedar Creek, Unity Road).$t$, 'serves', $t$Motorists, rural residents$t$, 'status', $t$existing$t$),
      jsonb_build_object('name', $t$Public Safety / Fire & Sheriff$t$, 'description', $t$Jail HVAC replacement; equipment for 22 fire departments; sheriff's office needs.$t$, 'serves', $t$County residents, first responders$t$, 'status', $t$prospective$t$),
      jsonb_build_object('name', $t$River Access & Recreation$t$, 'description', $t$Boat launches, bank stabilization, trailhead facilities along the Saline River.$t$, 'serves', $t$Residents, recreational users$t$, 'status', $t$existing$t$),
      jsonb_build_object('name', $t$Flood Mitigation / Tornado Sirens$t$, 'description', $t$Flood gates at low-water crossings; replacement of aging tornado sirens countywide.$t$, 'serves', $t$Rural residents, motorists, county residents$t$, 'status', $t$prospective$t$),
      jsonb_build_object('name', $t$Rodeo Arena/Fairgrounds Reconstruction$t$, 'description', $t$Full rebuild of county-owned fairgrounds destroyed in the February 2026 ice storm.$t$, 'serves', $t$General public, event users$t$, 'status', $t$prospective$t$)
    ),
    'partnerships', $t$Metroplan (MPO, primary infrastructure funding conduit); CAPDD; ARDOT (Local Bridge Program, TAP/RTP); ADEM (FEMA BRIC state administrator); Garver (engineer of record); Volkert; McClelland Engineering; AGFC (river access); Keep Arkansas Beautiful; Blue & You Foundation; USDA Rural Development.$t$,
    'additional_info', $t$County government, Benton, AR (county seat), serving Saline County. Arkansas county structure: County Judge is chief executive; Quorum Court approval gates expenditures and match. Match capacity comfortable at 80/20 and 90/10; 60/40 or 1:1 on large capital is a stretch and must be programmed in advance. Advisory constraints (not hard gates): CDBG ineligible (population/income profile disqualify from entitlement and state-administered CDBG); owns no street lights/sidewalks/gutters, limiting SS4A Implementation fit; city-specific projects inside Benton or Bryant route through Metroplan rather than the County.$t$
  ),
  org_type = $t$government$t$,
  service_area = array[$t$Saline County, Arkansas$t$]::text[],
  primary_funding_needs = array[$t$Capital / construction / renovation$t$, $t$Program expansion / direct services$t$]::text[]
where name = $t$Saline County$t$;

-- Ozark Regional Transit
update clients set
  intake_data = coalesce(intake_data, '{}'::jsonb) || jsonb_build_object(
    'mission', $t$Regional transit authority providing public transportation for Northwest Arkansas.$t$,
    'funding_need', $t$Transit capital and operations (specifics pending onboarding). Per pipeline knowledge outside the intake, FHWA ATTAIN and FTA ICAM Pilot have been flagged as strong prospective fits.$t$,
    'priority_areas', to_jsonb(array[$t$Equipment / technology$t$, $t$Capital / construction / renovation$t$]::text[]),
    'programs', jsonb_build_array(
      jsonb_build_object('name', $t$Regional public transit service$t$, 'description', $t$Public transportation across the Northwest Arkansas corridor. Detailed program profile pending onboarding intake (not yet completed).$t$, 'serves', $t$Northwest Arkansas transit riders$t$, 'status', $t$existing$t$)
    ),
    'partnerships', $t$Not yet documented (onboarding intake incomplete).$t$,
    'additional_info', $t$Government/transit authority, Springdale, AR, serving the Northwest Arkansas transit corridor. Contact: Joel Gardner, Executive Director. IMPORTANT: onboarding intake/kickoff has not been completed and no full client profile exists in Drive beyond the signed contract. This profile is built from limited known information. Per firm policy, no grant outreach proceeds until onboarding is complete and Shannon is present. FHWA ATTAIN and FTA ICAM Pilot noted as prospective fits pending Shannon-led onboarding.$t$
  ),
  org_type = $t$government$t$,
  service_area = array[$t$Northwest Arkansas$t$, $t$Springdale, AR$t$]::text[],
  primary_funding_needs = array[$t$Equipment / technology$t$, $t$Capital / construction / renovation$t$]::text[]
where name = $t$Ozark Regional Transit$t$;

-- Pathway to Freedom
update clients set
  intake_data = coalesce(intake_data, '{}'::jsonb) || jsonb_build_object(
    'mission', $t$Transform the lives of prisoners and ex-prisoners for successful reentry through faith-based, Christ-centered programming.$t$,
    'funding_need', $t$Prisoner reentry and in-prison rehabilitation, reentry housing (NWA expansion), vocational training, facility and program-space expansion, and community/church partnerships.$t$,
    'priority_areas', to_jsonb(array[$t$Capital / construction / renovation$t$, $t$Program expansion / direct services$t$]::text[]),
    'programs', jsonb_build_array(
      jsonb_build_object('name', $t$Residential pre-release program$t$, 'description', $t$18-24 month program at the Wrightsville Hawkins Unit.$t$, 'serves', $t$Incarcerated individuals$t$, 'status', $t$existing$t$),
      jsonb_build_object('name', $t$Post-release mentoring/reentry support$t$, 'description', $t$12 months of housing, employment, spiritual guidance, and family/community connection.$t$, 'serves', $t$Released individuals$t$, 'status', $t$existing$t$),
      jsonb_build_object('name', $t$Curriculum-based workshops$t$, 'description', $t$Wild at Heart, Peacemaker; life skills and pro-social values.$t$, 'serves', $t$Incarcerated participants$t$, 'status', $t$existing$t$),
      jsonb_build_object('name', $t$Reentry housing expansion (NWA)$t$, 'description', $t$Capital construction plus program delivery; pursuing ~$1.5M Arkansas Community Assistance Program grant.$t$, 'serves', $t$Reentry population, NWA$t$, 'status', $t$prospective$t$),
      jsonb_build_object('name', $t$Hawkins Unit facility/program expansion$t$, 'description', $t$Converting 256-bed underutilized space into offices/group rooms.$t$, 'serves', $t$Incarcerated participants$t$, 'status', $t$prospective$t$)
    ),
    'partnerships', $t$Arkansas Department of Corrections / Wrightsville Hawkins Unit; local churches and volunteers; Tyson Foods, George's, Walmart (second-chance hiring); Rock City Re-entry; Little Rock Workforce Development Board; Pulaski Tech; Restore Hope; Office of Skill Development.$t$,
    'additional_info', $t$Faith-based reentry nonprofit, Wrightsville, AR, 501(c)(3), serving statewide Arkansas (in-facility at Wrightsville Hawkins Unit plus statewide post-release) with targeted NWA expansion. Public revenue ~$806K FY2024. Advisory constraints (not hard gates): faith-based (Christ-centered) may exclude some secular funders; won't pursue grants that restrict/hamper mission or operations; cannot pursue new opioid-settlement funding until the existing $972K AG grant is closed out; key funder (Serving USA) typically doesn't fund construction; some funders require large non-government match.$t$
  ),
  org_type = $t$nonprofit$t$,
  service_area = array[$t$Arkansas statewide$t$, $t$Northwest Arkansas (expansion)$t$]::text[],
  primary_funding_needs = array[$t$Capital / construction / renovation$t$, $t$Program expansion / direct services$t$]::text[]
where name = $t$Pathway to Freedom$t$;

-- RROK / Dunyasi Ventures
update clients set
  intake_data = coalesce(intake_data, '{}'::jsonb) || jsonb_build_object(
    'mission', $t$Upskilling unemployed and underemployed Oklahomans, with an emphasis on rural communities, into AI Native Operators: workers trained to use AI tools as a core part of remote-capable jobs in sales, support, operations, and recruiting.$t$,
    'funding_need', $t$Workforce development funding to sustain RROK beyond the pilot phase (primary target: EDA AI Upskill Accelerator Pilot Program), plus operating/bridge support and WIOA co-enrollment/in-kind match.$t$,
    'priority_areas', to_jsonb(array[$t$Staffing / workforce$t$, $t$Program expansion / direct services$t$]::text[]),
    'programs', jsonb_build_array(
      jsonb_build_object('name', $t$AI Native Operator Training (4-week intensive)$t$, 'description', $t$Trains participants inside real company workflows across 4 role tracks (sales pipeline, customer support, ops/admin, recruiting), AI tools embedded, with employer-partner placement. Active pilot, June 2026 cohort, 11 participants.$t$, 'serves', $t$Unemployed/underemployed Oklahomans, rural focus$t$, 'status', $t$existing$t$),
      jsonb_build_object('name', $t$Two-Track Model — Track 1 (Remote Ops)$t$, 'description', $t$Trains new entrants for remote operations careers.$t$, 'serves', $t$Underemployed/unemployed Oklahomans entering remote work$t$, 'status', $t$prospective$t$),
      jsonb_build_object('name', $t$Two-Track Model — Track 2 (Incumbent AI Upskilling)$t$, 'description', $t$Trains existing employees at legacy Oklahoma employers to use AI in current roles.$t$, 'serves', $t$Mid-career/incumbent workers at partner companies$t$, 'status', $t$prospective$t$)
    ),
    'partnerships', $t$Oklahoma Baptist University (lead IHE partner, confirmed); UpskillOK/Oklahoma State Regents (prospective credentialing); Choctaw Nation of Oklahoma (warm, status uncertain); Oklahoma Farm Bureau (LOI in progress); Oklahoma CareerTech; Activate Oklahoma Accelerator; GRANTED (grant strategy/writing, proposed post-award admin contractor).$t$,
    'additional_info', $t$For-profit LLC, Oklahoma (statewide, rural emphasis). OUT-OF-STATE (Oklahoma) — an exception to GRANTED's domestic-Arkansas focus. Advisory/structural flags (not simple gates): staffing-commission revenue model must stay structurally and narratively separate from grant-funded scope (audit/fraud risk); needs operating/bridge support between now and any EDA award (earliest Nov 2026).$t$
  ),
  org_type = $t$for_profit$t$,
  service_area = array[$t$Oklahoma statewide (rural emphasis)$t$]::text[],
  primary_funding_needs = array[$t$Staffing / workforce$t$, $t$Program expansion / direct services$t$]::text[],
  hard_constraints = jsonb_build_array(jsonb_build_object('type', $t$role_ceiling$t$, 'value', $t$sub$t$, 'note', $t$For-profit LLC cannot be federal prime or co-applicant; cap at subawardee/contractor under an eligible IHE lead (funder prior approval required for the subaward). Applied unscoped (conservative) because scope matching cannot reliably detect federal-ness; verify per grant.$t$, 'action', $t$cap_role$t$))
where name = $t$RROK / Dunyasi Ventures$t$;

-- MSET
update clients set
  intake_data = coalesce(intake_data, '{}'::jsonb) || jsonb_build_object(
    'mission', $t$Leverage NASA's expertise, state assets, and higher education to create and retain high-wage jobs in Mississippi via technology transfer and economic development.$t$,
    'funding_need', $t$Technology transfer, economic and business development, workforce development, accelerator/incubator development, and commercialization of university research in aerospace, defense, energy, and AI.$t$,
    'priority_areas', to_jsonb(array[$t$Staffing / workforce$t$, $t$Program expansion / direct services$t$]::text[]),
    'programs', jsonb_build_array(
      jsonb_build_object('name', $t$Mississippi's official Technology Transfer Office$t$, 'description', $t$Links federal labs/universities with private industry (state designation).$t$, 'serves', $t$Mississippi aerospace/defense/tech sector$t$, 'status', $t$existing$t$),
      jsonb_build_object('name', $t$Innovation accelerator/incubator$t$, 'description', $t$Aerospace, defense, energy, AI; third-party operated, university + private-capital partnership.$t$, 'serves', $t$Mississippi startups/researchers$t$, 'status', $t$prospective$t$),
      jsonb_build_object('name', $t$Workforce training aligned with federal contracting regs$t$, 'description', $t$Technical/educational engagement at Stennis.$t$, 'serves', $t$Mississippi workforce$t$, 'status', $t$existing$t$)
    ),
    'partnerships', $t$NASA; federal labs; Mississippi universities/research foundations; Mississippi Development Authority; Aerospace and Defense Trade Association; Accelerate Mississippi; Plug and Play; Innovate Mississippi (potential).$t$,
    'additional_info', $t$Private nonprofit, John C. Stennis Space Center, Hancock County, MS, 501(c)(3), serving Mississippi statewide (aerospace/defense/tech sectors). OUT-OF-STATE (Mississippi) — an exception to GRANTED's domestic-Arkansas focus. Operates Mississippi's official Technology Transfer Office (state designation). Advisory constraints (not hard gates): facing loss of ~$200K NASA funding in 2026; state-level grant access is politically sensitive, avoids direct competition with MDA/Innovate Mississippi and often positions as subcontractor/partner rather than prime; small administrative team; difficulty securing match for higher-match programs.$t$
  ),
  org_type = $t$nonprofit$t$,
  service_area = array[$t$Mississippi statewide$t$]::text[],
  primary_funding_needs = array[$t$Staffing / workforce$t$, $t$Program expansion / direct services$t$]::text[]
where name = $t$MSET$t$;


-- 3 INSERTs (new active clients; upsert on clients_name_uniq)

-- GreenLab, Inc.
insert into clients (name, status, org_type, service_area, primary_funding_needs, intake_data)
values (
  $t$GreenLab, Inc.$t$,
  'active',
  $t$for_profit$t$,
  array[$t$National / global markets$t$, $t$Arkansas (operations / feedstock)$t$]::text[],
  array[$t$Equipment / technology$t$]::text[],
  jsonb_build_object(
    'mission', $t$To green industry with next-generation plant biotechnology, using its proprietary GreenLab Vector Technology (GVT) farmentation platform to grow proteins and enzymes directly in corn, replacing costly fermentation-based production with a scalable, waste-free, cornfield-based manufacturing model.$t$,
    'funding_need', $t$R&D and scale-up for corn-expressed proteins and enzymes (SBIR/STTR-style federal biotech funding), funding to relocate/replicate the Woburn, MA lab capability to Arkansas, support for a proposed 501(c) AI-driven protein discovery arm, and programs tied to Arkansas farmer value-add and agricultural innovation.$t$,
    'priority_areas', to_jsonb(array[$t$Equipment / technology$t$]::text[]),
    'programs', jsonb_build_array(
      jsonb_build_object('name', $t$Brazzein commercialization$t$, 'description', $t$Corn-expressed natural sweet protein replacing costly fermentation-based brazzein for food/beverage sweetener systems. Lead go-to-market product, in active refinement with a contracted Woburn, MA lab.$t$, 'serves', $t$Food and beverage formulators, sweetener-system companies$t$, 'status', $t$existing$t$),
      jsonb_build_object('name', $t$MnP enzyme / PFAS remediation$t$, 'description', $t$Corn-expressed manganese peroxidase enzyme for breaking down PFAS and other contaminants in landfill/wastewater cleanup.$t$, 'serves', $t$Environmental remediation, industrial/municipal water treatment$t$, 'status', $t$prospective$t$),
      jsonb_build_object('name', $t$Industrial Enzyme Platform (GVT)$t$, 'description', $t$Corn-based protein/enzyme expression platform positioned as a low-cost, scalable alternative to fermentation; ~20 proteins integrated into corn.$t$, 'serves', $t$Food, feed, fuel, pharma, nutraceutical, industrial markets$t$, 'status', $t$existing$t$),
      jsonb_build_object('name', $t$Proposed 501(c) research arm$t$, 'description', $t$Nonprofit vehicle to hire students using AI-driven protein discovery, envisioned with University of Arkansas Center of Excellence for Food Science and Innovation.$t$, 'serves', $t$Academic researchers, food-science entrepreneurs$t$, 'status', $t$prospective$t$)
    ),
    'partnerships', $t$Nutriba (sweetener-systems company supplying Westrock/Walmart RTD lines); Novus International-owned contract lab (Woburn, MA); Ginkgo Bioworks; Allonnia; ASU research affiliation; prospective University of Arkansas Center of Excellence for Food Science and Innovation and Market Center of the Ozarks food hub.$t$,
    'additional_info', $t$For-profit biotechnology company, Arkansas (verify HQ address), serving national/global markets with Arkansas agricultural-feedstock framing. No prior grant history (first-time applicant, SAM.gov status unconfirmed). Advisory flag (not a hard gate): a pending ~$6M commercial fundraise is a live SBIR/STTR size/ownership eligibility question and must be checked against each program's standards. Contact: use paigejernigan@mac.com for Paige (corporate email has deliverability issues).$t$
  )
)
on conflict (name) do update set
  intake_data = coalesce(clients.intake_data, '{}'::jsonb) || excluded.intake_data,
  org_type = excluded.org_type,
  service_area = excluded.service_area,
  primary_funding_needs = excluded.primary_funding_needs;

-- Arkansas Game and Fish Foundation
insert into clients (name, status, org_type, service_area, primary_funding_needs, intake_data)
values (
  $t$Arkansas Game and Fish Foundation$t$,
  'active',
  $t$nonprofit$t$,
  array[$t$Arkansas statewide$t$, $t$Northwest Arkansas (regional projects)$t$]::text[],
  array[$t$Program expansion / direct services$t$, $t$Equipment / technology$t$, $t$Capital / construction / renovation$t$]::text[],
  jsonb_build_object(
    'mission', $t$Nonprofit partner to the Arkansas Game and Fish Commission since 1982, supporting the Commission's conservation, wildlife habitat, and education work and keeping the next generation of Arkansans Unplugged and Engaged in the outdoors.$t$,
    'funding_need', $t$Youth development and outdoor education (R3: recruit, retain, reactivate), habitat restoration and pollinator/species-of-concern conservation, law enforcement and game warden equipment, and family-foundation and corporate philanthropy.$t$,
    'priority_areas', to_jsonb(array[$t$Program expansion / direct services$t$, $t$Equipment / technology$t$, $t$Capital / construction / renovation$t$]::text[]),
    'programs', jsonb_build_array(
      jsonb_build_object('name', $t$Generation Conservation$t$, 'description', $t$Annual educational summit: outdoor skills workshops, stewardship programming (Entergy-funded, ~$100K).$t$, 'serves', $t$Youth and outdoor enthusiasts statewide$t$, 'status', $t$existing$t$),
      jsonb_build_object('name', $t$Get It For Game Wardens$t$, 'description', $t$Funds AGFC Enforcement Division equipment (e-bikes, medical backpacks, drones, thermal binoculars, boats, K9 units); $500K+ raised since 2021.$t$, 'serves', $t$AGFC Game Wardens / Enforcement$t$, 'status', $t$existing$t$),
      jsonb_build_object('name', $t$Archery Program$t$, 'description', $t$Youth archery instruction and equipment.$t$, 'serves', $t$Youth statewide$t$, 'status', $t$existing$t$),
      jsonb_build_object('name', $t$Arkansas Legacy Lunker Program$t$, 'description', $t$Trophy bass certification/rewards, voluntary genetics donation, annual boat giveaway.$t$, 'serves', $t$Anglers statewide$t$, 'status', $t$existing$t$),
      jsonb_build_object('name', $t$Fred Berry Crooked Creek Nature Center Habitat Restoration$t$, 'description', $t$1,800-acre restoration footprint: native grassland/woodland restoration, prescribed fire, with USFWS/AGFC/AR Wildlife Federation/Quail Forever.$t$, 'serves', $t$Wildlife, pollinators, migratory birds (Marion Co.)$t$, 'status', $t$existing$t$),
      jsonb_build_object('name', $t$Little Osage Creek / NWA 150-Acre Property$t$, 'description', $t$Converting cattle pasture to native grasses/pollinator habitat, streambank restoration (Bentonville).$t$, 'serves', $t$NWA wildlife and pollinator habitat$t$, 'status', $t$prospective$t$)
    ),
    'partnerships', $t$Entergy; Electric Cooperatives of Arkansas; Chevy Dealers of Arkansas; Union Pacific (Community Ties); Greenway Equipment; U.S. Fish and Wildlife Service; Arkansas Wildlife Federation; Quail Forever. Funder relationships include Walton Family Foundation.$t$,
    'additional_info', $t$Independent nonprofit supporting/fiscal-sponsor organization, statewide Arkansas with regional projects, 501(c)(3) (EIN 71-0562360; files its own 990; public revenue ~$8M FY2023). It supports but does not operate under the Arkansas Game and Fish Commission (a separate state agency). Advisory constraints (not hard gates): Arkansas only (statewide or regional); routes federal coordination through Deke rather than directly to AGFC staff; prefers to avoid complex federal procurement unless scale warrants; its supporting-org/fiscal-sponsor role creates an eligibility gray area on pass-through grants — flag on every assessment, do not auto-qualify.$t$
  )
)
on conflict (name) do update set
  intake_data = coalesce(clients.intake_data, '{}'::jsonb) || excluded.intake_data,
  org_type = excluded.org_type,
  service_area = excluded.service_area,
  primary_funding_needs = excluded.primary_funding_needs;

-- Epic Glass and Recycling
insert into clients (name, status, org_type, service_area, primary_funding_needs, intake_data)
values (
  $t$Epic Glass and Recycling$t$,
  'active',
  $t$nonprofit$t$,
  array[$t$Arkansas statewide$t$, $t$Surrounding states (potential expansion)$t$]::text[],
  array[$t$Equipment / technology$t$, $t$Program expansion / direct services$t$, $t$Planning / assessment$t$]::text[],
  jsonb_build_object(
    'mission', $t$Help Arkansas communities and municipalities start sustainable, efficient glass recycling programs, keeping glass out of landfills and closing the recycling loop statewide.$t$,
    'funding_need', $t$Drop-off containers and collection equipment, collection vehicles, community outreach and engagement, program expansion into new municipalities, and planning/strategic assessment.$t$,
    'priority_areas', to_jsonb(array[$t$Equipment / technology$t$, $t$Program expansion / direct services$t$, $t$Planning / assessment$t$]::text[]),
    'programs', jsonb_build_array(
      jsonb_build_object('name', $t$Commercial Bin Collection$t$, 'description', $t$Delivers 96-gallon glass totes to businesses, swapped on schedule.$t$, 'serves', $t$Restaurants, bars, hotels, breweries, and other businesses (Central AR/NWA)$t$, 'status', $t$existing$t$),
      jsonb_build_object('name', $t$Public Drop-Off Recycling$t$, 'description', $t$Free 24/7 public glass drop-off bins/green stations.$t$, 'serves', $t$General public in Central Arkansas metro cities$t$, 'status', $t$existing$t$),
      jsonb_build_object('name', $t$Municipal Glass Sourcing$t$, 'description', $t$Supplies of waste glass from partner cities.$t$, 'serves', $t$Rogers, Hot Springs, Conway, Fairfield Bay, Little Rock$t$, 'status', $t$existing$t$),
      jsonb_build_object('name', $t$Program Expansion / New Municipality Launch$t$, 'description', $t$Stand up glass recycling infrastructure (drop-off containers, collection vehicles) in new municipalities.$t$, 'serves', $t$New/expansion municipalities statewide$t$, 'status', $t$prospective$t$)
    ),
    'partnerships', $t$Municipal glass-supply partners (Rogers, Hot Springs, Conway, Fairfield Bay, Little Rock); municipal drop-off host sites.$t$,
    'additional_info', $t$501(c)(3) (confirmed via client intake), Arkansas statewide with potential expansion to surrounding states. VERIFICATION FLAG (advisory, does not gate): affiliated companies ACE Glass Construction and CenterLine Systems share a contact domain (cl@aceglass.net) with Epic Glass under a Closing the Loop network. If Epic Glass shares ownership/staff/finances with the for-profit ACE Glass Construction, it could affect prime eligibility on some programs — confirm directly with Courtney before relying on it in any eligibility assessment. Several operational details (account counts, host-city list, curbside status) are marked NEEDS VERIFICATION in the source and should be confirmed.$t$
  )
)
on conflict (name) do update set
  intake_data = coalesce(clients.intake_data, '{}'::jsonb) || excluded.intake_data,
  org_type = excluded.org_type,
  service_area = excluded.service_area,
  primary_funding_needs = excluded.primary_funding_needs;

insert into schema_migrations (version) values ('0047_client_profile_load') on conflict do nothing;

commit;
