// Core matching engine — GRANTED Brain Document logic encoded as Claude prompts
// Logic source: IntelEngine Universal Matching Process Flow (5-Phase Logic Spec)
// + AI Calibration Email Logs compiled by Samantha from Shannon's expert overrides.

import { getAnthropicClient, MODEL } from "@/lib/anthropic";
import type { Client, Grant, IdealApplicantProfile } from "@/types/database";

export interface ExtractedGrant {
  funder: string;
  fon: string;
  title: string;
  description: string;
  total_funding: string;
  award_range_min: string;
  award_range_max: string;
  award_range_is_estimate: boolean;
  num_awards: string;
  submission_deadline: string;
  period_of_performance: string;
  cost_share: string;
  eligible_entity_types: string[];
  geographic_eligibility: string;
  ineligible_entities: string;
  focus_areas: string[];
  scoring_rubric: Record<string, number | string>;
  // New Phase 1 fields
  program_type: "Competitive Grant" | "Cooperative Agreement" | "TTA Cooperative Agreement" | "Other";
  delivery_model: string;
  grant_status: "Active" | "Forecasted" | "Monitor for reissuance";
  scoring_criteria_high_value: string[];
  technical_burden_flags: string[];
  incumbent_risk: string;
  subaward_prohibited: boolean;
  hard_disqualifiers: string[];
  verification_flags: string[];
}

export interface MatchResult {
  client_id: string;
  fit_score: 0 | 1 | 2 | 3;
  // Closed-menu seat the client occupies (e.g. "P0", "S0_1", or "NONE"). The
  // numeric ceiling is derived from this IN CODE -- the model does not pick the
  // final number.
  seat_ref: string;
  proposed_role: string;
  recommended_prime: string | null;
  why_this_org: string[];
  concept_synopsis: string;
  description_short: string;
  draft_outreach_email: string;
  outreach_track: "Track 1" | "Track 2";
  before_you_approve: string[];
  inferred_fields: string[];
  reasoning_context: {
    eligibility_analysis: string;
    fit_score_derivation: string;
    role_assignment_logic: string;
    consortium_rationale: string;
    concept_derivation: string;
    why_not_others: string;
  };
  // Suppression (Phase 0 pre-filter — set before scoring runs)
  suppressed: boolean;
  suppress_reason: string | null;
  disqualified: boolean;
  disqualify_reason?: string;
}

const EXTRACTION_SYSTEM_PROMPT = `You are a federal grant analyst for GRANTED, a domestic-only U.S. grant consulting firm.
Your job is to extract structured data from a grant announcement or NOFO page text.

Phase 1 rules (run in order before any matching):

STEP 1 -- Extract core identity fields. Every field feeds downstream logic.
STEP 2 -- Auto-flag hard disqualifiers (binary kill switch -- any match = suppress ALL clients):
  KILL: For-profit entity in any recipient role
  KILL: Federal agency as applicant
  KILL: International organization
  KILL: 501(c)(4) with confirmed lobbying activity under LDA
  KILL: Geography entirely outside U.S.
  NOTE: 501(c)(4) + lobbying = "requires check" not auto-kill. Do not assume until confirmed.
STEP 3 -- Extract scoring rubric as structured point-weight table.
  Flag any criterion worth 20 or more points as HIGH-PRIORITY.
  Common high-priority criteria: Project design/approach (25+ pts), Budget narrative (20+ pts),
  Environmental/program results (20+ pts), Innovative technology (20+ pts), Past performance (any pts).
  Flag QA/QAPP, SDMP, or data management plan requirements as technical burden.
STEP 4 -- Detect program architecture signals:
  Is this a competitive grant or a cooperative agreement?
  Is it a TTA (Technical Assistance) delivery model?
  How many awards are expected nationally or regionally?
  Are there fixed slots that imply incumbents?
  Flag "rurality standard not cited" -- do not assume eligibility.
  Flag "full NOFO not yet posted" -- press releases may omit threshold criteria.
STEP 5 -- Determine grant status:
  Active: NOFO posted, deadline in the future, confirmed open competition.
  Forecasted: Pre-announcement, forecast only, no NOFO yet.
  Monitor for reissuance: Pre-January 2025 NOFO or prior cycle closed -- may not have been reissued.

General rules:
- Label award amounts as estimates if the NOFO does not state them explicitly
- Extract ALL eligible entity types exactly as stated
- Never rely on training data for deadlines -- extract only what is in the text
- Do not use em dashes in any output

Return a JSON object matching this exact schema:
{
  "funder": string,
  "fon": string,
  "title": string,
  "description": string (50 words max, plain language),
  "total_funding": string,
  "award_range_min": string,
  "award_range_max": string,
  "award_range_is_estimate": boolean,
  "num_awards": string,
  "submission_deadline": string,
  "period_of_performance": string,
  "cost_share": string,
  "eligible_entity_types": string[],
  "geographic_eligibility": string,
  "ineligible_entities": string,
  "focus_areas": string[],
  "scoring_rubric": object (criterion name -> point value or description),
  "program_type": "Competitive Grant" | "Cooperative Agreement" | "TTA Cooperative Agreement" | "Other",
  "delivery_model": string (brief: "direct service", "TTA delivery", "research", "infrastructure", etc.),
  "grant_status": "Active" | "Forecasted" | "Monitor for reissuance",
  "scoring_criteria_high_value": string[] (criteria worth 20+ points -- flag these for narrative attention),
  "technical_burden_flags": string[] (QA/QAPP requirements, SDMP, data mgmt plan, peer-reviewed outputs, etc.),
  "incumbent_risk": string (notes on fixed slots, existing cooperative agreements, prior recipients with selection preference),
  "subaward_prohibited": boolean (true if NOFO explicitly prohibits subawards -- this collapses consortium architecture to a single-applicant model),
  "hard_disqualifiers": string[] (reasons this program is disqualified for ALL clients),
  "verification_flags": string[] (items needing human verification before acting on any match)
}`;

const MATCHING_SYSTEM_PROMPT = `You are GRANTED's AI matching engine — IntelEngine. GRANTED is a U.S.-only grant consulting firm.
You match federal and non-federal funding opportunities to specific client organizations.

Logic source: IntelEngine 5-Phase Universal Matching Process Flow + Shannon's AI Calibration Rules.

CORE PRINCIPLES:
1. Never force-fit. A weak match is worse than no match. Never force a narrative where one doesn't exist.
2. Eligibility is a spectrum. "Technically eligible" and "strong fit" are different outputs.
3. Always distinguish prime eligibility from subrecipient/partner eligibility. These are different roles.
4. Program architecture matters as much as topic alignment. A perfect topic match on a fixed-slot TTA program is a false positive.
5. Never use em dashes in any output.
6. Always label award amounts as estimates unless the NOFO states them explicitly.
7. Flag every inferred field. Never surface a confident score built on unverified assumptions.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
PHASE 0 -- SUPPRESSION PRE-FILTERS
Run BEFORE triage. Run BEFORE topic or eligibility matching. These are not scoring factors.
Any match = set suppressed=true with the matching reason. Do not score. Do not surface.
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

SUPPRESS: Expected award count = 1 nationally AND scope is national/TTA
  -- Award will go to a national intermediary with existing network relationships.
  -- No Arkansas-anchored applicant has a realistic prime path.
  -- Exception: client is a credentialed national intermediary with existing program infrastructure.

SUPPRESS: Fixed-slot TTA cooperative agreement (e.g., 6-10 regional slots) AND client has no existing multi-state TTA footprint
  -- Fixed slots imply incumbents. Check prior recipients before treating as open competition.
  -- A cold applicant anchored in one state cannot prime a multi-state TTA center.
  -- Severity gradient: 1 slot = full suppress, 6 slots = moderate suppress, 10 slots = lower suppress.

SUPPRESS: Cooperative agreement + TTA delivery model + client is not a national intermediary
  -- TTA delivery models require existing multi-state infrastructure, not just subject matter alignment.
  -- Topic match alone is not sufficient. Program architecture overrides topic.

SUPPRESS: Sub-initiative pool under $5M statewide
  -- Do not recommend as standalone pursuit. Award size too small for level of effort.

SUPPRESS: Reimbursement-only program AND client has no confirmed cash flow to front costs
  -- Flag as "requires cash flow confirmation" before advancing.

SUBAWARD PROHIBITION -- CONSORTIUM COLLAPSE RULE:
If subaward_prohibited = true, there is no pass-through structure. The application is single-applicant only.
  -- Do NOT recommend a co-applicant or subrecipient structure for any partner. Every partner is a contractor or named collaborator only.
  -- Remove all subrecipient and co-applicant role assignments. Consortium architecture collapses to: Prime + Named Collaborators only.
  -- If the client cannot serve as the sole prime, they cannot participate as a recipient at all. Route to facilitator only.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
PHASE 1 -- TRIAGE (6 GATES, run in sequence)
First gate failure = disqualify for direct pursuit. Assess alternative route.
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Gate 1 -- Domestic scope: U.S.-only. International = disqualify.
Gate 2 -- Entity type: Is this client's org type in the eligible entity list? For-profit = route to facilitator only.
Gate 3 -- Geography: Does client's service area overlap the eligible region? HUC watershed, state restriction, rurality standard.
Gate 4 -- Purpose alignment: Does what this grant actually rewards match what this client does?
Gate 5 -- Award size: Is the award range realistic for this client's capacity and delivery model?
Gate 6 -- Deadline viability: Can the client realistically submit? Under 4 weeks = very tight, flag immediately.

ROUTE LOGIC (failure is not always a full kill):
- Direct eligible -> proceed to fit scoring.
- Not directly eligible but viable partner -> Co-Applicant or Subrecipient route. Flag as partner pursuit.
- For-profit or ineligible entity -> Facilitator role only. Introductions, not application.
- Federal agency -> Named non-recipient technical collaborator. No funds under any structure.
- State administrator with conflict risk -> Letter of support only.
- No viable route -> KILL. Do not stretch the narrative.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
PHASE 2 -- SEAT MAPPING + STRENGTH SCORE (anchored on the grant's ideal applicant)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

You are GIVEN an IDEAL APPLICANT PROFILE for this grant (in the GRANT block):
the core funded role, 1-3 valid prime archetypes, and the partner seats each
archetype implies. It was built from the full NOFO, independent of any client.
DO NOT re-derive it. Score by mapping the client onto it.

NEVER reason from client to grant ("they're eligible, so maybe a 2"). Reason
from the grant's ideal structure to the client: which SEAT, if any, does this
client genuinely occupy? The seat is the OUTPUT of the mapping; the score is the
STRENGTH of that placement. If no profile was provided, score conservatively and
do not invent prime fit.

STAGE B -- MAP THE CLIENT TO A SEAT (this determines proposed_role):
- Prime: the client IS one of the ideal prime archetypes -- it performs the core
  funded role as its natural function, not merely "eligible to apply."
- Co-Applicant / Partner: the client genuinely fills a named partner seat the
  profile implies (e.g. the research-university anchor, an employer partner).
- Sub / Named Collaborator: real but peripheral participation.
- Facilitator: not in the structure, but has a documented relationship with an
  org that should prime (see INTRODUCTION VEHICLE RULE).
- None: not in the picture at all.
A client technically eligible to prime but NOT matching an ideal prime archetype
maps to its real seat (partner/sub) or to None -- never anointed Prime for
eligibility alone.

STAGE C -- SCORE = SEAT (ceiling) x STRENGTH. Score by SEAT OCCUPANCY, NEVER by
competitive comparison. Do NOT ask "is there a stronger applicant?" -- there is
ALWAYS a stronger applicant somewhere (a state agency, a flagship university),
and it is IRRELEVANT. The only question is which seat THIS client occupies.
Comparing the client against hypothetical or real stronger entities is forbidden:
it ceilings everyone at 2 and is the exact error to avoid.

- 3 -- The client OCCUPIES a prime archetype seat (performs the core funded role
  as its natural function) AND the fit is clean and strong. Occupancy, not
  superiority: a genuine prime-seat occupant that fits strongly is a 3 EVEN IF
  other strong primes also exist. Do not withhold 3 because some other entity
  could also lead.
- 2 -- The client occupies a real SUPPORTING seat from the menu with strong fit;
  OR it occupies a prime seat but the fit is conditional (regional not statewide,
  needs a partner, scope refinement).
- 1 -- The client occupies a real seat but only weakly / peripherally -- a
  genuine toehold with marginal strength.
- 0 -- NO genuine seat: topical/mission adjacency only, or not eligible. If you
  describe the client as "implementation anchor only," a "delivery partner" on a
  coordination grant, "adjacent," or "not the coordinator/convener," that is a
  NO-SEAT finding -> seat_ref = NONE -> score 0. It does NOT surface. This is the
  correct, expected outcome for most clients; surfacing a no-seat client wastes
  reviewer time and is a costly error.

NO-SEAT IS 0 -- never 1, never 2. A 1 or 2 REQUIRES occupying a real seat from
the menu. Adjacency with no genuine seat is 0, no matter how topically related.

BEFORE SCORING: choose seat_ref from the SEAT MENU (in the GRANT block) -- the
single menu id of the seat this client genuinely occupies, or NONE. The numeric
ceiling is ENFORCED IN CODE from your seat_ref: PRIME -> max 3, SUPPORTING ->
max 2, NONE -> 0. You cannot score above it, so choose honestly. Your fit_score
is strength WITHIN the seat (a conditional prime fit is 2 not 3; a weak occupancy
is 1). Record the chosen seat and the gating factor in reasoning_context.

STRENGTH is a composite; factor 1 sets the CEILING, factors 2-6 decide placement
within it (it is NOT an average):
1. SEAT (ceiling): prime seat -> ceiling 3; genuine supporting seat -> ceiling 2;
   adjacency only -> ceiling 1; no seat -> 0. Dominant factor.
2. Eligibility cleanliness -- TWO filters: (a) entity type eligible AND (b)
   program scope/purpose aligned. Broad eligibility lists create false positives;
   clearing entity type is necessary, not sufficient. Topical adjacency != fit.
3. Geographic fit -- RUCC/rural eligibility, service area, place-based rules
   (RUCC 2 metro auto-fails rural-designated programs).
4. Program history / track record -- prior awards, incumbency, past performance
   on the relevant mechanism (prime vs sub history is distinct).
5. Match / cost-share feasibility for THIS client -- a real disqualifier even
   when eligible; small-budget, match-sensitive clients fail high-match programs.
6. Population / mission alignment -- does the served population and mission
   genuinely fit the program intent.

Populate reasoning_context with the per-factor rationale: name the seat, and the
factor that gated or set the score.

Only create cards for scores 2 and 3. A 1 is awareness only; a 0 never surfaces.

INTRODUCTION VEHICLE RULE:
When an active client has no seat itself but has a documented relationship with
an org that SHOULD prime, surface proposed_role = "Facilitator" with a
concept_synopsis describing the warm-intro play; outreach goes THROUGH the
client. Score on the value of the introduction, not a forced application fit.

STRENGTH SIGNALS (cite when present; they move placement WITHIN the seat ceiling,
they do NOT change the seat):
BOOST: prior award lifecycle advancement (planning -> implementation; FRA/DOT/EPA
  reward this); named state-plan alignment; pre-existing stakeholder networks the
  program model requires; federal grant history as prime (verify USASpending);
  wide rural footprint for statewide rural programs; required tech/AI capacity.
FLAG: no prime-level federal history (past-performance gap); no QA/QAPP capacity
  where required; SAM.gov expiring < 60 days; reimbursement burden without cash
  flow; anti-government posture; pre-2025 NOFO (monitor for reissuance); no
  existing stakeholder network where the model requires one.

ROLE VOCABULARY (proposed_role): Prime | Co-Applicant | Sub | Named Collaborator
| Letter of Support | Facilitator | Not Recommended.
HARD ROLE RULES (override the mapping):
- For-profit entities: Facilitator or Named Collaborator ONLY. NEVER Prime,
  Co-Applicant, or Subrecipient.
- Federal agencies: Named Collaborator ONLY.
- A client that maps to Prime but lacks prime-level federal history on a large
  award: flag the past-performance risk and recommend an experienced
  co-applicant -- a strength penalty that often drops a would-be 3 to a 2.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
PHASE 4 -- OUTREACH SEQUENCING
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Identify the CRITICAL PATH CONTACT first: the one whose absence makes the application concept unfundable.
Map dependency chain: what must be confirmed before anything else can be scoped?
Always include hard deadline in all outreach -- creates urgency without requiring follow-up pressure.
Name at least one other consortium member in initial outreach -- signals organized effort.

OUTREACH TRACK:
- Track 1: existing GRANTED client (Navigate or Flex tier). Direct, conversational tone. Opens with "I want to get this on your radar before the window gets any tighter."
- Track 2: prospect. More formal, context-setting. Named capability citation, consortium context shown, specific role offered.

FOUNDATION AND CORPORATE GIVING (non-federal) -- separate logic:
Foundation grants operate differently from federal competitive grants. Do not apply federal program architecture rules to foundation opportunities.
- Relationship-staged entry: most foundations require a relationship before LOI. Flag "relationship-gated -- no cold application" when applicable.
- Rolling vs. cycle-based: note whether the funder has open rolling applications or defined cycles. Flag if cycle dates are unconfirmed.
- "Contact required before submission" rules: some funders (family foundations, corporate giving programs) require advisor pre-contact. Flag timing constraint explicitly.
- Internal sponsor model: corporate giving programs (Walmart, Tyson) often require an internal employee sponsor before an application is viable. Flag as prerequisite.
- Pre-engagement rule: Shannon contacts foundation funders solo first. Never copy the client until a positive signal is confirmed.
- WFF (Walton Family Foundation) rule: do not recommend for a client that does not yet have a physical NWA presence or established WFF relationship.
- Award range inconsistency ($500 to $1.2M from same funder in one year) = low predictability signal. Flag for planning purposes.

TONE BY CONTACT TYPE (apply in draft email):
- Warm existing client: Direct, no re-explaining the relationship, one specific action requested.
- Cold institutional (dean, agency staff): Formal, specific capability cited, consortium context shown, proposed role named, hard deadline included.
- Prospect: Formal, grant opportunity as the warm introduction mechanism.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
HUMAN VALIDATION GATES -- Surface these in before_you_approve. Do not automate past these.
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

STOP: USASpending verification -- confirm prime has federal assistance agreements as prime (not subrecipient) in last 3 years.
STOP: 501(c) status + lobbying check -- confirm entity type, verify no lobbying activity under LDA.
STOP: Organizational appetite -- confirm org is willing to be a named federal grant partner.
STOP: Conflict of interest check -- confirm no dual-role conflicts (state administrator in same program area).
STOP: NOFO confirmation -- verify full NOFO has been posted on Grants.gov and FON matches announcement.
STOP: Key personnel bandwidth -- confirm PI or lead staff has capacity for multi-year federal commitment.
STOP: County governments -- quorum court must approve match commitments; flag deadlines at least 6 weeks in advance.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
CLIENT-SPECIFIC RULES (CRITICAL -- these override general logic)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Client-specific rules are NOT hardcoded here. Each client carries its own
authoritative overrides in the "Matching Rules" field of its profile, supplied
in the CLIENT block below. Treat any rule in that field as authoritative: apply
it BEFORE the general logic above, and let it override a general conclusion
wherever the two conflict. An override can both rule a client OUT (a constraint
the general logic would miss) and clear a client IN (e.g. "natural prime on
workforce awards" overriding a general research-only ceiling). If the field is
empty or "None", apply the general logic only.

Return a JSON object with this exact schema:
{
  "client_id": string,
  "fit_score": 1 | 2 | 3,
  "proposed_role": "Prime" | "Co-Applicant" | "Sub" | "Named Collaborator" | "Letter of Support" | "Facilitator" | "Not Recommended",
  "recommended_prime": string | null,
  "why_this_org": string[] (1-2 specific bullets citing actual signals -- not generic eligibility language),
  "concept_synopsis": string (2-3 sentences: "X org develops [program] that does [Y], in partnership with [Z], to serve [population/geography]."),
  "description_short": string (50 words max: what this grant funds, who is eligible, the core purpose -- plain language),
  "draft_outreach_email": string (full email ready to send, correct tone for track),
  "outreach_track": "Track 1" | "Track 2",
  "before_you_approve": string[] (human validation gates -- distinguish inferred from confirmed; cite specific stops),
  "inferred_fields": string[] (fields reasoned or assumed, not confirmed from NOFO or client record),
  "reasoning_context": {
    "eligibility_analysis": string (step-by-step: suppression check, each triage gate, how client satisfies or fails each),
    "fit_score_derivation": string (why this specific score -- which boosters applied, which penalties, what deciding factors),
    "role_assignment_logic": string (why this role specifically; if sub or co-applicant, why this prime),
    "consortium_rationale": string (team composition: who brings what, completeness check vs. scoring criteria, gaps flagged),
    "concept_derivation": string (how the proposed SOW was scoped -- what NOFO signals and client profile drove the approach),
    "why_not_others": string (brief on why other client types are a weaker fit for this specific opportunity)
  },
  "suppressed": boolean,
  "suppress_reason": string | null,
  "disqualified": boolean,
  "disqualify_reason": string | null
}`;

export async function extractGrantData(rawText: string): Promise<ExtractedGrant> {
  const client = getAnthropicClient();

  const response = await client.messages.create({
    model: MODEL,
    // Higher ceiling + larger input window: real NOFOs run 100K+ chars and a
    // full scoring rubric is sizable output. Too low truncates the rubric.
    max_tokens: 4000,
    system: EXTRACTION_SYSTEM_PROMPT,
    messages: [
      {
        role: "user",
        content: `Extract structured grant data from the following text. Return only valid JSON, no other text.\n\n${rawText.slice(0, 120000)}`,
      },
    ],
  });

  const text = response.content[0].type === "text" ? response.content[0].text : "";
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) throw new Error("Claude did not return valid JSON for grant extraction");

  return JSON.parse(jsonMatch[0]) as ExtractedGrant;
}

// ─── Stage A (Step 3): Ideal Applicant / Consortium Profile ──────────────────
// Constructed from the full NOFO, anchored on the grant, independent of our
// roster. Multi-archetype (1-3 prime shapes). Clients later map onto a seat in
// this profile, and the seat sets the score ceiling. This is what stops the
// engine reaching from client to grant ("eligible, so a 2?") and instead makes
// clients earn their way onto the grant's ideal structure.
const IDEAL_PROFILE_SYSTEM_PROMPT = `You construct the IDEAL APPLICANT / CONSORTIUM PROFILE for a U.S. federal grant, for GRANTED, a domestic grant consulting firm. Anchor entirely on the GRANT, never on any client.

Derive the profile from the NOFO's SUBSTANCE -- the funded activities, the review/scoring criteria, and the program design -- NOT from the eligibility list. Eligibility is a weak, downweighted input: "allows nonprofits" does NOT make a nonprofit the ideal applicant.

Produce:
- core_funded_role: the central activity the money actually pays for. One phrase (e.g. "regional coordination / backbone", "direct service delivery", "applied research", "capital construction"). This is the gate the whole downstream score hangs on.
- summary: 1-2 sentences on who this grant is built for.
- archetypes: 1 to 3 DISTINCT valid prime shapes. Output more than one ONLY when the grant legitimately supports different entity types priming from different angles (e.g. a county, a nonprofit, OR an IHE each leading a different version). Each archetype:
  - label: short name of the prime shape (e.g. "Regional coordination backbone")
  - ideal_prime_shape: what kind of entity is BUILT to lead this angle, by natural function (not "who is eligible")
  - core_role: the funded role this archetype's prime performs
  - partner_seats: the consortium seats this prime implies (e.g. "IHE research partner", "employer partners", "third-party evaluator")
- eligibility_note: brief note on the stated eligibility, explicitly secondary.

Be concrete and grant-specific. Do not use em dashes. Return via the submit_profile tool.`;

export async function constructIdealApplicantProfile(
  nofoText: string,
): Promise<IdealApplicantProfile> {
  const anthropic = getAnthropicClient();
  const response = await anthropic.messages.create({
    model: MODEL,
    max_tokens: 3000,
    temperature: 0,
    system: IDEAL_PROFILE_SYSTEM_PROMPT,
    tools: [
      {
        name: "submit_profile",
        description: "Return the grant's ideal applicant/consortium profile. Call exactly once.",
        input_schema: {
          type: "object",
          properties: {
            core_funded_role: { type: "string" },
            summary: { type: "string" },
            archetypes: {
              type: "array",
              minItems: 1,
              maxItems: 3,
              items: {
                type: "object",
                properties: {
                  label: { type: "string" },
                  ideal_prime_shape: { type: "string" },
                  core_role: { type: "string" },
                  partner_seats: { type: "array", items: { type: "string" } },
                },
                required: ["label", "ideal_prime_shape", "core_role", "partner_seats"],
              },
            },
            eligibility_note: { type: "string" },
          },
          required: ["core_funded_role", "summary", "archetypes"],
        },
      },
    ],
    tool_choice: { type: "tool", name: "submit_profile" },
    messages: [
      {
        role: "user",
        content: `Construct the ideal applicant/consortium profile from this NOFO.\n\n${nofoText.slice(0, 120000)}`,
      },
    ],
  });

  if (response.stop_reason === "max_tokens") {
    throw new Error("Ideal-profile response truncated at max_tokens");
  }
  const toolUse = response.content.find((b) => b.type === "tool_use");
  if (!toolUse || toolUse.type !== "tool_use") {
    throw new Error("Claude did not return a structured ideal applicant profile");
  }
  return toolUse.input as IdealApplicantProfile;
}

// Build a closed menu of the seats a client may occupy, from the grant's ideal
// applicant profile. The model picks exactly one id (seat_ref); the score
// ceiling is derived from the seat TYPE in code -- prime -> 3, partner -> 2,
// NONE/invalid -> 0. A closed menu stops the model inventing a flattering seat.
function buildSeatMenu(
  profile: IdealApplicantProfile | null,
): { menu: string; seats: Map<string, "prime" | "partner"> } {
  const seats = new Map<string, "prime" | "partner">();
  if (!profile || !Array.isArray(profile.archetypes) || profile.archetypes.length === 0) {
    return { menu: "No profile available -- no seats exist. seat_ref must be NONE.", seats };
  }
  const lines: string[] = [];
  profile.archetypes.forEach((a, i) => {
    const pid = `P${i}`;
    seats.set(pid, "prime");
    lines.push(`${pid} = PRIME seat -- "${a.label}": performs the core funded role (${a.core_role}).`);
    (a.partner_seats || []).forEach((s, j) => {
      const sid = `S${i}_${j}`;
      seats.set(sid, "partner");
      lines.push(`${sid} = SUPPORTING seat under "${a.label}": ${s}`);
    });
  });
  lines.push("NONE = the client occupies NONE of the above (topical adjacency only / not in this consortium).");
  return { menu: lines.join("\n"), seats };
}

export async function matchGrantToClient(
  grant: Grant,
  client: Client,
  usaSpendingContext?: string
): Promise<MatchResult> {
  const anthropic = getAnthropicClient();
  const { menu: seatMenu, seats: seatTable } = buildSeatMenu(grant.ideal_applicant_profile);

  const grantContext = `GRANT:
Title: ${grant.title}
Funder: ${grant.funder}
FON: ${grant.fon}
Description: ${grant.description}
Award Range: ${grant.award_range_min} - ${grant.award_range_max}${grant.award_range_min ? " (estimate if not explicitly stated in NOFO)" : ""}
Total Funding: ${grant.total_funding}
Deadline: ${grant.submission_deadline}
Cost Share: ${grant.cost_share}
Eligible Entity Types: ${(grant.eligible_entity_types || []).join(", ")}
Geographic Eligibility: ${grant.geographic_eligibility}
Ineligible Entities: ${grant.ineligible_entities}
Focus Areas: ${(grant.focus_areas || []).join(", ")}
Program Type: ${(grant as Grant & { program_type?: string }).program_type || "Unknown"}
Subaward Prohibited: ${(grant as Grant & { subaward_prohibited?: boolean }).subaward_prohibited ? "YES -- single-applicant model only" : "No"}
Scoring Criteria (High Value): ${((grant as Grant & { scoring_criteria_high_value?: string[] }).scoring_criteria_high_value || []).join("; ")}
Technical Burden Flags: ${((grant as Grant & { technical_burden_flags?: string[] }).technical_burden_flags || []).join("; ")}
Incumbent Risk: ${(grant as Grant & { incumbent_risk?: string }).incumbent_risk || "None noted"}

IDEAL APPLICANT PROFILE (constructed from the full NOFO -- map the client onto THIS):
${grant.ideal_applicant_profile ? JSON.stringify(grant.ideal_applicant_profile, null, 2) : "Not constructed (no full NOFO). Score conservatively; do not assume a prime seat."}

SEAT MENU -- the client occupies exactly ONE of these. Return its id as seat_ref.
Pick NONE unless the client GENUINELY occupies a listed seat; NONE is the correct,
expected answer for most clients and is NOT a failure. A regional entity does not
occupy a STATEWIDE prime seat just because it is the same entity type -- it takes
the supporting seat. Honor the client's Matching Rules. Do not pick a seat the
client does not truly fill in order to lift the score.
${seatMenu}`;

  const clientContext = `CLIENT:
Name: ${client.name}
Org Type: ${client.org_type}
Engagement Tier: ${client.engagement_tier}
Location: ${[client.location_city, client.location_county, client.location_state].filter(Boolean).join(", ")}
Service Area: ${(client.service_area || []).join(", ")}
RUCC Codes: ${client.rucc_codes || "Unknown"}
Annual Budget: ${client.annual_budget || "Unknown"}
Primary Funding Needs: ${(client.primary_funding_needs || []).join(", ")}
Project Stage: ${client.project_stage || "Unknown"}
Match/Cost Share Capacity: ${client.match_cost_share_capacity || "Unknown"}
Federal Grant History: ${usaSpendingContext || client.federal_grant_history || "Unknown -- USASpending not checked"}
SAM/UEI Status: ${client.sam_uei_status || "Unknown"}
Known Constraints: ${client.known_constraints || "None noted"}
Matching Rules (AUTHORITATIVE OVERRIDES -- apply before general logic): ${client.matching_rules || "None"}`;

  // Force structured output via a tool call so parsing is not a regex gamble:
  // the model must return the schema as the tool input, which arrives already
  // parsed. max_tokens is generous so a rich, high-fit match (full draft email
  // + six reasoning paragraphs) can finish; truncation is surfaced explicitly
  // below rather than silently producing unparseable output.
  const response = await anthropic.messages.create({
    model: MODEL,
    max_tokens: 8000,
    // Low temperature for stable scoring: borderline 2-vs-3 calls must not
    // flip run to run. Stability is the prerequisite for calibration; the
    // rubric boundary itself is tuned separately.
    temperature: 0,
    system: MATCHING_SYSTEM_PROMPT,
    tools: [
      {
        name: "submit_match",
        description:
          "Return the structured grant-client match evaluation. Call this tool exactly once.",
        input_schema: {
          type: "object",
          properties: {
            seat_ref: { type: "string" },
            fit_score: { type: "integer", enum: [0, 1, 2, 3] },
            proposed_role: { type: "string" },
            recommended_prime: { type: ["string", "null"] },
            why_this_org: { type: "array", items: { type: "string" } },
            concept_synopsis: { type: "string" },
            description_short: { type: "string" },
            draft_outreach_email: { type: "string" },
            outreach_track: { type: "string", enum: ["Track 1", "Track 2"] },
            before_you_approve: { type: "array", items: { type: "string" } },
            inferred_fields: { type: "array", items: { type: "string" } },
            reasoning_context: {
              type: "object",
              properties: {
                eligibility_analysis: { type: "string" },
                fit_score_derivation: { type: "string" },
                role_assignment_logic: { type: "string" },
                consortium_rationale: { type: "string" },
                concept_derivation: { type: "string" },
                why_not_others: { type: "string" },
              },
              required: [
                "eligibility_analysis",
                "fit_score_derivation",
                "role_assignment_logic",
                "consortium_rationale",
                "concept_derivation",
                "why_not_others",
              ],
            },
            suppressed: { type: "boolean" },
            suppress_reason: { type: ["string", "null"] },
            disqualified: { type: "boolean" },
            disqualify_reason: { type: ["string", "null"] },
          },
          required: [
            "seat_ref",
            "fit_score",
            "proposed_role",
            "why_this_org",
            "concept_synopsis",
            "description_short",
            "draft_outreach_email",
            "outreach_track",
            "before_you_approve",
            "inferred_fields",
            "reasoning_context",
            "suppressed",
            "disqualified",
          ],
        },
      },
    ],
    tool_choice: { type: "tool", name: "submit_match" },
    messages: [
      {
        role: "user",
        content: `Evaluate this grant-client match.\n\n${grantContext}\n\n${clientContext}`,
      },
    ],
  });

  // Truncation must never again masquerade as "bad JSON" -- surface it explicitly.
  if (response.stop_reason === "max_tokens") {
    throw new Error(
      `Match response truncated at max_tokens for client ${client.name} -- raise max_tokens`,
    );
  }

  const toolUse = response.content.find((b) => b.type === "tool_use");
  if (!toolUse || toolUse.type !== "tool_use") {
    throw new Error(
      `Claude did not return a structured match for client ${client.name}`,
    );
  }

  const result = toolUse.input as MatchResult;
  result.client_id = client.id;

  // Enforce the seat -> ceiling IN CODE. The model picks a seat from the closed
  // menu (seat_ref) and a raw strength read; the final score is the strength
  // capped by the seat's ceiling. A no-seat / invalid ref (NONE) is a hard 0 --
  // this is the gate the prose-only instruction could never bind. The model
  // does not get to free-form the number above its seat.
  const rawScore = typeof result.fit_score === "number" ? result.fit_score : 0;
  if (grant.ideal_applicant_profile) {
    const seatType = seatTable.get(result.seat_ref ?? "");
    const ceiling = seatType === "prime" ? 3 : seatType === "partner" ? 2 : 0;
    result.fit_score = Math.min(rawScore, ceiling) as 0 | 1 | 2 | 3;
  } else {
    // No profile to anchor seats: cannot verify a prime seat, so cap at 2.
    result.fit_score = Math.min(rawScore, 2) as 0 | 1 | 2 | 3;
  }
  return result;
}

// ─── JavaScript Pre-Filter ──────────────────────────────────────────────────
// Run BEFORE any Claude calls. Eliminates obvious mismatches in milliseconds.
// Returns a reason string if the client should be skipped, null if Claude should run.

export function jsPreFilter(
  extracted: ExtractedGrant,
  client: Client
): string | null {
  const eligibleTypes = (extracted.eligible_entity_types || []).map((t) =>
    t.toLowerCase()
  );
  const numAwards = parseInt(extracted.num_awards || "999", 10);
  const isTTA =
    extracted.program_type === "TTA Cooperative Agreement" ||
    (extracted.delivery_model || "").toLowerCase().includes("tta");

  // Global suppression: single national award -- will go to national intermediary
  if (numAwards === 1 && !isNaN(numAwards)) {
    return "Single national award -- suppressed for all clients";
  }

  // Global suppression: TTA cooperative agreement with 10 or fewer fixed slots
  if (isTTA && numAwards <= 10 && !isNaN(numAwards)) {
    return `Fixed-slot TTA cooperative agreement (${numAwards} slots) -- requires existing multi-state infrastructure`;
  }

  // For-profit clients can never be recipients in federal grants
  if (client.org_type === "Small Business" || client.org_type === "small_business") {
    const allowsSmallBusiness = eligibleTypes.some(
      (t) => t.includes("small business") || t.includes("for-profit") || t.includes("unrestricted")
    );
    if (!allowsSmallBusiness && eligibleTypes.length > 0) {
      return "For-profit / small business not in eligible entity types";
    }
  }

  // Entity type mismatch check -- skip if client type clearly not in eligible list
  if (eligibleTypes.length > 0 && !eligibleTypes.some((t) => t.includes("unrestricted"))) {
    const orgTypeKeywords: Record<string, string[]> = {
      // Platform org_type values
      nonprofit: ["nonprofit", "501(c)(3)", "501c3", "non-profit", "private nonprofit"],
      local_government: ["county", "local government", "municipal", "city or township", "special district"],
      small_business: ["small business", "for-profit", "profit organization"],
      higher_education: ["higher education", "university", "college", "community college", "institutions of higher", "institution of higher", "ihe"],
      // Legacy / descriptive labels (kept for back-compat with richer profiles)
      "County Government": ["county", "local government", "municipal", "city or township"],
      "Nonprofit 501c3": ["nonprofit", "501(c)(3)", "501c3", "non-profit", "private nonprofit"],
      "Community College": ["higher education", "community college", "college", "university", "institution of higher"],
      "Transit Authority": ["transit", "special district", "public transit", "transportation authority"],
      "Health System": ["nonprofit", "501(c)(3)", "health", "hospital"],
      "FQHC": ["health center", "fqhc", "nonprofit", "501(c)(3)", "federally qualified"],
      "Small Business": ["small business", "for-profit", "profit organization"],
      "Other": [],
    };

    const keywords = orgTypeKeywords[client.org_type ?? ""] || [];
    if (
      keywords.length > 0 &&
      !keywords.some((kw) => eligibleTypes.some((t) => t.includes(kw)))
    ) {
      return `Entity type mismatch: ${client.org_type} not in eligible list`;
    }
  }

  return null; // passed pre-filter -- proceed to Claude
}

// ─── Domestic scope filter ───────────────────────────────────────────────────
// GRANTED is U.S.-only; international programs are flagged and excluded by
// default. This is a cheap heuristic on funder/title (no model call) to keep
// foreign opportunities out of the feed and out of the matching spend. The
// matching engine's Gate 1 (domestic) remains the authoritative backstop.
const INTERNATIONAL_MARKERS = [
  "u.s. mission",
  "u.s. embassy",
  "u.s. consulate",
  "american embassy",
  "usaid",
  "agency for international development",
  "bureau of african affairs",
  "bureau of near eastern affairs",
  "bureau of east asian",
  "bureau of south and central asian",
  "bureau of western hemisphere affairs",
  "bureau of european and eurasian",
  "bureau of international",
  "bureau of democracy, human rights",
  "bureau of population, refugees",
  "bureau of oceans and international",
  "global health center",
  "-ghc",
  "global aids",
  "office of global",
  "overseas",
  "foreign assistance",
];

/** True if the opportunity looks international (and should be excluded by default). */
export function looksInternational(
  funder: string | null | undefined,
  title: string | null | undefined,
): boolean {
  const text = `${funder ?? ""} ${title ?? ""}`.toLowerCase();
  return INTERNATIONAL_MARKERS.some((m) => text.includes(m));
}



const SIMPLER_GOV_API = "https://api.simpler.grants.gov";

// Applicant type codes returned by the API mapped to human-readable labels
const APPLICANT_TYPE_MAP: Record<string, string> = {
  state_governments: "State Governments",
  county_governments: "County Governments",
  city_or_township_governments: "City or Township Governments",
  special_district_governments: "Special District Governments",
  independent_school_districts: "Independent School Districts",
  public_and_state_institutions_of_higher_education: "Public/State Institutions of Higher Education",
  private_institutions_of_higher_education: "Private Institutions of Higher Education",
  federally_recognized_native_american_tribal_governments: "Federally Recognized Native American Tribal Governments",
  other_native_american_tribal_organizations: "Other Native American Tribal Organizations",
  public_and_indian_housing_authorities: "Public and Indian Housing Authorities",
  nonprofits_having_a_501c3_status_with_the_irs: "Nonprofits 501(c)(3)",
  nonprofits_that_do_not_have_a_501c3_status_with_the_irs: "Nonprofits (non-501c3)",
  for_profit_organizations_other_than_small_businesses: "For-Profit Organizations",
  small_businesses: "Small Businesses",
  individuals: "Individuals",
  unrestricted_eligible: "Unrestricted (all entity types)",
  other: "Other",
};

const FUNDING_CATEGORY_MAP: Record<string, string> = {
  recovery_act: "Recovery Act",
  agriculture: "Agriculture",
  arts: "Arts",
  business_and_commerce: "Business and Commerce",
  community_development: "Community Development",
  consumer_protection: "Consumer Protection",
  disaster_prevention_and_relief: "Disaster Prevention and Relief",
  education: "Education",
  employment_labor_and_training: "Employment, Labor and Training",
  energy: "Energy",
  environment: "Environment",
  food_and_nutrition: "Food and Nutrition",
  health: "Health",
  housing: "Housing",
  humanities: "Humanities",
  information_and_statistics: "Information and Statistics",
  income_security_and_social_services: "Income Security and Social Services",
  law_justice_and_legal_services: "Law, Justice and Legal Services",
  natural_resources: "Natural Resources",
  opportunity_zone_benefits: "Opportunity Zone Benefits",
  regional_development: "Regional Development",
  science_technology_and_other_research_and_development: "Science and Technology R&D",
  transportation: "Transportation",
  affordable_care_act: "Affordable Care Act",
  other: "Other",
};

// Extract opportunity ID from a Simpler.gov URL
// Handles: https://simpler.grants.gov/opportunities/12345
//          https://simpler.grants.gov/opportunities/12345/any-slug
export function extractSimplerGovOpportunityId(url: string): string | null {
  try {
    const parsed = new URL(url);
    if (!parsed.hostname.includes("simpler.grants.gov")) return null;
    // Public detail URLs use the singular path with a UUID
    // (/opportunity/<uuid>); older/legacy links use the plural path with an
    // integer id (/opportunities/<int>). Accept both. Both resolve via the
    // GET /v1/opportunities/{id} route (uuid → canonical, int → legacy handler).
    const match = parsed.pathname.match(
      /\/opportunit(?:y|ies)\/([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}|\d+)/,
    );
    return match ? match[1] : null;
  } catch {
    return null;
  }
}

// Fetch a single opportunity from the Simpler.gov API and map to ExtractedGrant
export async function fetchFromSimplerGovAPI(
  opportunityId: string
): Promise<{ extracted: ExtractedGrant; rawJson: string; detail: Record<string, unknown> }> {
  const apiKey = process.env.SIMPLER_GOV_API_KEY;
  if (!apiKey) throw new Error("Missing SIMPLER_GOV_API_KEY env var");

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);

  try {
    const res = await fetch(`${SIMPLER_GOV_API}/v1/opportunities/${opportunityId}`, {
      signal: controller.signal,
      headers: {
        "X-API-Key": apiKey,
        "Content-Type": "application/json",
      },
    });

    if (!res.ok) throw new Error(`Simpler.gov API returned HTTP ${res.status}`);

    const json = await res.json();
    const opp = json.data ?? json; // API wraps in { data: ... }
    // Per the v1 spec, opportunity detail (awards, applicant types, funding
    // categories, cost share, description, deadline) lives under `summary`.
    const summary = opp.summary ?? {};

    const applicantTypes: string[] = (summary.applicant_types ?? []).map(
      (t: string) => APPLICANT_TYPE_MAP[t] ?? t
    );

    const focusAreas: string[] = (summary.funding_categories ?? []).map(
      (c: string) => FUNDING_CATEGORY_MAP[c] ?? c
    );

    const awardFloor = summary.award_floor != null ? String(summary.award_floor) : "";
    const awardCeiling = summary.award_ceiling != null ? String(summary.award_ceiling) : "";
    const totalFunding =
      summary.estimated_total_program_funding != null
        ? `$${Number(summary.estimated_total_program_funding).toLocaleString()}`
        : "";

    const extracted: ExtractedGrant = {
      funder: opp.agency_name ?? "",
      fon: opp.opportunity_number ?? "",
      title: opp.opportunity_title ?? "",
      description: summary.summary_description ?? "",
      total_funding: totalFunding,
      award_range_min: awardFloor ? `$${Number(awardFloor).toLocaleString()}` : "",
      award_range_max: awardCeiling ? `$${Number(awardCeiling).toLocaleString()}` : "",
      // Award amounts from the API are confirmed — not estimates
      award_range_is_estimate: summary.award_floor == null && summary.award_ceiling == null,
      num_awards:
        summary.expected_number_of_awards != null ? String(summary.expected_number_of_awards) : "",
      submission_deadline: summary.close_date ?? "",
      period_of_performance: summary.forecasted_project_start_date
        ? `Project start (forecast): ${summary.forecasted_project_start_date}`
        : "",
      cost_share: summary.is_cost_sharing === true ? "Cost sharing required" : summary.is_cost_sharing === false ? "No cost sharing required" : "Not specified",
      eligible_entity_types: applicantTypes,
      geographic_eligibility: "United States (federal program)",
      ineligible_entities: "",
      focus_areas: focusAreas,
      scoring_rubric: {},
      program_type: "Competitive Grant",
      delivery_model: "direct service",
      grant_status: "Active",
      scoring_criteria_high_value: [],
      technical_burden_flags: [],
      incumbent_risk: "",
      subaward_prohibited: false,
      hard_disqualifiers: [],
      verification_flags: [
        "Verify submission deadline from official NOFO before acting",
        "Check Grants.gov for full NOFO text including scoring rubric",
        "Confirm eligible entity types match client before outreach",
      ],
    };

    // Return the parsed opportunity too, so the NOFO-deepening step (Step 2)
    // can harvest attachments / competition instructions / additional_info_url.
    return { extracted, rawJson: JSON.stringify(json, null, 2), detail: opp as Record<string, unknown> };
  } finally {
    clearTimeout(timeout);
  }
}

// Fetch full NOFO text from a non-Simpler.gov URL (HTML scrape fallback)
export async function fetchGrantTextFromUrl(url: string): Promise<string> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);

  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { "User-Agent": "Mozilla/5.0 (compatible; Argo/1.0; grant research)" },
    });

    if (!res.ok) throw new Error(`HTTP ${res.status} fetching ${url}`);

    const html = await res.text();

    return html
      .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, " ")
      .replace(/<[^>]+>/g, " ")
      .replace(/&nbsp;/g, " ")
      .replace(/&amp;/g, "&")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/\s+/g, " ")
      .trim();
  } finally {
    clearTimeout(timeout);
  }
}

// Keep old export name as alias so existing callers don't break
export const fetchGrantText = fetchGrantTextFromUrl;
