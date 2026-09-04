// Direct-alignment scorer (MATCH_DIRECT_ALIGN_ENABLED) -- the REPLACEMENT for the occupancy/seat scorer.
//
// WHAT THIS IS. The retired occupancy scorer (engine.ts matchGrantToClient) asked "can I seat this entity
// somewhere in the grant's ideal consortium?" -- and the answer was almost always yes, which inflated a
// funder like AGFF onto a field-implementer PRIME. This asks the two questions a skilled analyst asks, and
// nothing else:
//   1. ELIGIBILITY + ROLE -- is the client an eligible recipient, and in what role?
//   2. FUNCTIONAL ALIGNMENT -- does the grant's funded PURPOSE match what this org actually DOES?
// It reads the client's distilled client_profile (mission, core_capabilities, prime_capacity.can_prime) --
// the functional-fit facts the occupancy scorer was structurally barred from seeing (#140) -- and scores
// alignment directly.
//
// THE #140 RAZOR is the one thing that keeps this from repeating the incident the seat model existed to
// prevent: score ALIGNMENT to the funded purpose, NEVER competitiveness ("is there a stronger applicant?").
// It lives in the prompt (the only place it can); the eval's integrative-fit anchor is its guard.
//
// FLAG-GATED, byte-identical OFF. matchGrantToClient branches to alignScoreClient only when
// MATCH_DIRECT_ALIGN_ENABLED === "true"; OFF, this file is never entered and the occupancy path is exactly
// today's. Revert is flip-off + redeploy (Vercel binds env at build), same as every other match flag.
//
// SCHEMA-PRESERVING. It returns the SAME MatchResult shape the occupancy path returns (fit_score,
// proposed_role, reasoning_context, factor_scores, ...), so every downstream reader (the card upsert,
// calibration, the report, feedback) is unchanged. seat_ref is DERIVED from the role (for calibration's
// seatFamily) and entity_required is vestigial-false -- the model no longer picks a seat. It reuses the
// KEPT machinery verbatim: applyHardConstraints (role ceilings / funder exclusions / do-not-surface, all
// seat-independent) and sanitizeOutreachEmail. Phase-0 grant-level suppressions stay upstream in jsPreFilter.
//
// PURE-TESTABLE. buildAlignUserContent, finalizeAlignMatch, and seatRefForRole are pure and exported; the
// model call is injectable (AlignDeps.runModel), so the plumbing is unit-tested with no network. The
// scoring QUALITY is the model-in-the-loop gate (align-score.eval.test.ts), which must pass before the flag
// is flipped.

import { getAnthropicClient, MODEL } from "@/lib/anthropic";
import { sanitizeOutreachEmail } from "@/lib/email/sanitize";
import { applyHardConstraints, formatConstraintsForPrompt } from "@/lib/grants/constraints";
import { formatSamForMatcher } from "@/lib/sam/expiry";
import { formatClientProfileForScoring } from "@/lib/clients/profile";
import type { Client, Grant, IdealApplicantProfile, FactorScores } from "@/types/database";
// Type-only import (erased at runtime -> no cycle with engine.ts, which is a protected file this must not
// modify). We only borrow the MatchResult shape so downstream sees an identical contract.
import type { MatchResult } from "@/lib/grants/engine";

export function matchDirectAlignEnabled(): boolean {
  return process.env.MATCH_DIRECT_ALIGN_ENABLED === "true";
}

// The deterministic funder cap (MATCH_FUNDER_CAP_ENABLED, default OFF). When on, finalizeAlignMatch caps a
// can_prime=FALSE money-mover with NO concrete role on THIS grant at fit_score 1 -- the code lever the prompt
// alone could not enforce (across two prompt iterations the model kept handing a topical
// conservation-foundation-on-a-conservation-grant a consolation partner-2 despite the no-go rule). The
// SEMANTIC read stays with the model (is_money_mover / concrete_role_on_this_grant booleans on the submit
// tool); code owns only the CONSEQUENCE. OFF is byte-identical: finalizeAlignMatch never reads the flag, so
// fit_score is exactly the model's.
export function matchFunderCapEnabled(): boolean {
  return process.env.MATCH_FUNDER_CAP_ENABLED === "true";
}

const ALIGN_SYSTEM_PROMPT = `You are GRANTED's grant-client fit evaluator. GRANTED is a U.S.-only grant consulting firm. For ONE grant and ONE client you decide whether the client should pursue the grant, by answering the two questions a skilled grant analyst asks -- and NOTHING else:

  1. ELIGIBILITY + ROLE. Is this client an eligible RECIPIENT of this grant, and in what ROLE?
  2. FUNCTIONAL ALIGNMENT. Does the grant's funded PURPOSE (the activity the money actually pays for, and the population/place it serves) match what THIS organization actually DOES?

You are given the grant (funder, purpose, eligible entity types, geography, deadline), the client's confirmed facts, AND the client's distilled profile (mission, core capabilities, prime capacity, populations, geography). Reason from BOTH questions together. Do not invent a role or a fit the facts do not support.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
THE #140 RAZOR (read first -- it governs everything below)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Score ALIGNMENT TO THE FUNDED PURPOSE. NEVER score COMPETITIVENESS.
Never ask "is there a stronger applicant?" -- there is ALWAYS a stronger applicant somewhere (a state agency, a flagship university), and it is IRRELEVANT. A genuine fit is a genuine fit even if larger or better-resourced orgs also fit. Do NOT lower a score because the client is not the strongest possible applicant. A broad-mission regional organization genuinely fits MANY grants across sectors -- score that real fit; never penalize breadth or treat "integrative / multi-sector" as weak. The only question is whether THIS client is eligible and does what this grant funds -- not how it ranks against others.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
QUESTION 1 -- ELIGIBILITY + ROLE
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Role vocabulary (proposed_role): Prime | Co-Applicant | Sub | Named Collaborator | Letter of Support | Facilitator | Not Recommended.
- The client's prime_capacity.can_prime is AUTHORITATIVE for the Prime role. If can_prime is FALSE, the client CANNOT be Prime on this grant -- full stop. Assess instead whether it genuinely fills a partner role (Co-Applicant / Sub / Named Collaborator), a Facilitator / introduction role, or none.
- HARD ROLE RULES: a for-profit entity is Facilitator or Named Collaborator ONLY (never Prime / Co-Applicant / Sub). A federal agency is Named Collaborator ONLY.
- PASS-THROUGH / INTERMEDIARY: a client that is the ultimate recipient but applies THROUGH a state agency / SAA / pass-through is STILL eligible -- record the route, do not disqualify. Only when the intermediary IS the recipient and the client cannot be one (even as a sub) is it ineligible.
- SUBAWARD PROHIBITED: if the grant prohibits subawards there is no sub / co-applicant structure -- the client is either the sole Prime or a non-recipient (Facilitator / Letter of Support only).
- Entity-type eligibility is NECESSARY, NOT SUFFICIENT. Clearing the eligible-entity list does not make a client a fit -- Question 2 still decides.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
QUESTION 2 -- FUNCTIONAL ALIGNMENT (the fit test)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Compare the grant's funded PURPOSE against the client's CORE CAPABILITIES / mission / programs: does this org actually PERFORM the funded work, for the funded population and place?
- A BROAD ASSET OR THEME MATCH IS NOT THE FUNDED WORK. Sharing a topic ("conservation", "education", "health") is not doing the specific funded activity. Having a library is not doing library-innovation research; being a conservation FOUNDATION that funds or fiscal-sponsors habitat work is not IMPLEMENTING field habitat work.
- Distinguish a FUNDER / grantmaker / fiscal sponsor from an IMPLEMENTER. If the client's capabilities show it raises, holds, or grants money, or fiscal-sponsors others, rather than performing the funded activity itself (typically can_prime=FALSE), it does NOT perform the funded work: it is not a Prime or implementer. A can_prime=FALSE funder / fiscal-sponsor earns a 2 or 3 ONLY when it has a CONCRETE role ON THIS grant -- a real partner/sub slot it actually fills, a fiscal-sponsor tie to a NAMED implementer applying to this grant, or an enumerated supporting function it genuinely performs. SHARED TOPIC OR MISSION OVERLAP IS NOT A ROLE: a conservation foundation on a conservation grant, a health funder on a health program, is topical adjacency, and you must NOT hand it a consolation partner/sub 2 for that overlap. Absent a concrete role on THIS specific grant, the score is AT MOST 1 (a Pass, never a routed 2); it is still 0 when the client is ineligible in every role or has no alignment at all. (This targets money-movers/grantmakers; a can_prime=FALSE org that genuinely IMPLEMENTS a real supporting function is a legitimate sub and is unaffected.)
- GEOGRAPHY / POPULATION: the client's service area and populations must overlap what the grant funds. A hard place / region restriction the client is entirely outside is disqualifying; the client's own rurality is a context flag, never a disqualifier.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
THE SCORE (0-3) -- alignment WITHIN eligibility, never competitiveness
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
- 3 -- Eligible in a real recipient role (Prime or strong partner) AND strong functional alignment: the org genuinely performs the funded work for the funded population/place. Clean, send-ready.
- 2 -- Eligible AND a genuine functional fit, but CONDITIONAL: a partner / sub structure is needed, the fit is a narrower slice than the whole program, or a real capacity / past-performance / match caveat must be resolved. Worth surfacing, conditional.
- 1 -- Eligible on paper but the org does NOT perform the funded activity / serve the funded population (topical or entity-type adjacency only), OR only a peripheral role exists. Does NOT surface -- this is a Pass.
- 0 -- Not an eligible recipient in any role, or no alignment at all.

Only 2 and 3 surface to a reviewer. Score honestly: a weak or forced fit is a 1, not a generous 2. Never force a narrative where one does not exist. A conditional fit is a 2, not a 3.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
HONESTY + OUTPUT
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
- Distinguish CONFIRMED facts from INFERRED ones; list every inferred field in inferred_fields. Never a confident score built on an unverified assumption.
- Label award amounts as estimates unless the NOFO states them. Extract deadlines only from the given text, never memory. Never use em-dashes (the "—" character).
- before_you_approve carries the human-validation STOPs where they apply: USASpending prime history, SAM.gov expiry < 60 days, 501(c) status + lobbying, organizational appetite, county quorum-court match approval, NOFO confirmation. Distinguish inferred from confirmed.
- If the client carries authoritative Matching Rules or code-enforced Hard Constraints, apply them BEFORE the general logic; they override a general conclusion.
- draft_outreach_email: body only, no "Subject:" line, no sender signature, greet the actual Primary Contact by name (or "Hello,"), no em-dashes.
- factor_scores: rate each of the 6 factors strong|moderate|weak|insufficient_data with a one-line rationale drawn from the reasoning you already did (invent no new analysis). The keys are fixed: seat_role (the appropriateness/strength of the assigned role), eligibility (entity-type + program-scope), geographic, program_history, cost_share, mission (funded-purpose alignment). Use insufficient_data when the client data a factor needs is blank -- never guess. Descriptive only; it does not change fit_score.
- is_money_mover / concrete_role_on_this_grant (two booleans, ALWAYS set): record the QUESTION 2 funder read. is_money_mover=TRUE when the client's OWN function is to raise/hold/grant/fiscal-sponsor money rather than implement the funded work (foundation/grantmaker/funder/fiscal sponsor, typically can_prime=FALSE); FALSE for a direct implementer. concrete_role_on_this_grant=TRUE ONLY when it fills a real partner/sub slot, a fiscal-sponsor tie to a NAMED implementer applying to THIS grant, or an enumerated supporting function it genuinely performs matching the funded activity -- NEVER a shared topic/mission overlap, same-theme grantmaking, or "could partner." When genuinely unsure: is_money_mover TRUE and concrete_role_on_this_grant FALSE (the safe direction). Set these to match your QUESTION 2 reasoning; still score fit_score by the rules above.

Return the evaluation via the submit_match tool exactly once.`;

// The submit tool -- the SAME MatchResult schema the occupancy path emits, MINUS seat_ref / entity_required
// (the model no longer picks a seat; code derives seat_ref from the role). Keeping every other field means
// the parsed result drops into cardFieldsFromMatch and every downstream reader unchanged.
const FACTOR_SCORE_SCHEMA = {
  type: "object",
  properties: {
    rating: { type: "string", enum: ["strong", "moderate", "weak", "insufficient_data"] },
    rationale: { type: "string" },
  },
  required: ["rating", "rationale"],
} as const;

const SUBMIT_ALIGN_TOOL = {
  name: "submit_match",
  description: "Return the structured grant-client fit evaluation. Call this tool exactly once.",
  input_schema: {
    type: "object" as const,
    properties: {
      fit_score: { type: "integer", enum: [0, 1, 2, 3] },
      proposed_role: {
        type: "string",
        enum: [
          "Prime",
          "Co-Applicant",
          "Sub",
          "Named Collaborator",
          "Letter of Support",
          "Facilitator",
          "Not Recommended",
        ],
      },
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
      factor_scores: {
        type: "object",
        properties: {
          seat_role: FACTOR_SCORE_SCHEMA,
          eligibility: FACTOR_SCORE_SCHEMA,
          geographic: FACTOR_SCORE_SCHEMA,
          program_history: FACTOR_SCORE_SCHEMA,
          cost_share: FACTOR_SCORE_SCHEMA,
          mission: FACTOR_SCORE_SCHEMA,
        },
        required: ["seat_role", "eligibility", "geographic", "program_history", "cost_share", "mission"],
      },
      suppressed: { type: "boolean" },
      suppress_reason: { type: ["string", "null"] },
      disqualified: { type: "boolean" },
      disqualify_reason: { type: ["string", "null"] },
      // Funder-cap classification (read by the deterministic cap in finalizeAlignMatch when
      // MATCH_FUNDER_CAP_ENABLED is on; NOT persisted on MatchResult). The MODEL owns the semantic read; code
      // owns the consequence. Both default to the SAFE direction on genuine ambiguity (money-mover TRUE,
      // concrete-role FALSE) so an unsure case still engages the cap rather than escaping it.
      is_money_mover: {
        type: "boolean",
        description:
          "TRUE if this client's OWN function is to RAISE, HOLD, GRANT, or FISCAL-SPONSOR money (a foundation, grantmaker, funder, or fiscal sponsor) rather than to PERFORM the funded activity itself (typically can_prime=FALSE). FALSE for an organization that directly implements/delivers the funded work. When genuinely unsure, return TRUE (the safe direction: it only engages the cap, which then still requires no concrete role).",
      },
      concrete_role_on_this_grant: {
        type: "boolean",
        description:
          "TRUE ONLY if the client fills a CONCRETE role on THIS SPECIFIC grant: a real partner/sub slot it actually fills, a fiscal-sponsor tie to a NAMED implementer applying to this grant, or an enumerated supporting function it genuinely performs that matches the funded activity. A SHARED TOPIC / MISSION / same-theme grantmaking overlap is NOT a role; 'could partner' is NOT a role. When genuinely unsure, return FALSE (the safe direction: ambiguity must not rescue a money-mover from the cap).",
      },
    },
    required: [
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
      "factor_scores",
      "suppressed",
      "disqualified",
      "is_money_mover",
      "concrete_role_on_this_grant",
    ],
  },
} as const;

// Role -> a FAMILY-ONLY seat_ref: calibration's seatFamily (P*->prime, S*->supporting, else none)
// classifies it, but consortium.ts's parseSeat -- whose PRIME_RE (/^P(\d+)$/) and SUPPORTING_RE
// (/^S(\d+)_\d+$/) both require a numeric archetype INDEX -- deliberately REJECTS it. Align scoring
// produces NO archetype (it is not seat/occupancy matching), so a bare "P"/"S" is the honest shape: the
// card is still classified for feedback calibration, while an align-scored card never enters occupancy
// consortium pairing. An earlier version emitted "P0"/"S0_0" to keep it parse-able, but that FABRICATED
// archetype 0 collided with real occupancy archetype-0 seats and produced spurious grant-detail consortium
// pairings on a mixed-scorer grant (#503). seat_ref is otherwise vestigial after the replace: derived from
// the role, never a scoring input.
export function seatRefForRole(role: string | null | undefined): string {
  const r = (role ?? "").trim().toLowerCase();
  if (r === "prime") return "P"; // seatFamily->prime; parseSeat rejects (no index) -> excluded from pairing
  if (r === "co-applicant" || r === "sub" || r === "named collaborator") return "S"; // seatFamily->supporting; parseSeat rejects
  return "NONE"; // facilitator / letter of support / not recommended / unknown -> no recipient seat
}

const clamp03 = (n: unknown): 0 | 1 | 2 | 3 => {
  const i = typeof n === "number" && Number.isFinite(n) ? Math.round(n) : 0;
  return (i < 0 ? 0 : i > 3 ? 3 : i) as 0 | 1 | 2 | 3;
};

// Distilled "what this grant funds" signal, reused from the grant's stored ideal_applicant_profile
// (core_funded_role + summary) -- built once per grant at ingest. We keep BUILDING that profile in Phase 1
// (prospect matching / consortium / the loadPool gate still depend on it); the scorer just reuses its
// grant-purpose distillation instead of the seat menu. Empty string when no profile is stored (the shredded
// description + focus areas still carry the purpose).
function fundedPurposeLine(profile: IdealApplicantProfile | null | undefined): string {
  if (!profile) return "";
  const parts = [profile.core_funded_role?.trim(), profile.summary?.trim()].filter(Boolean);
  return parts.length ? `Funded purpose (distilled from the NOFO): ${parts.join(" -- ")}` : "";
}

// The CLIENT PROFILE section. When no distilled client_profile exists -- a prospect scored via
// prospectAsClient (client_profile: null), or a real client the distiller has not reached yet -- profileText
// is empty, yet the system prompt asserts "you are given the distilled profile" and treats can_prime as
// AUTHORITATIVE. A silent gap would have the model judge on a profile it does not have, so emit an EXPLICIT
// no-profile block: mark can_prime UNKNOWN, forbid assuming Prime off an absent profile, and steer to a
// conservative score. finalizeAlignMatch adds a deterministic before_you_approve flag on the SAME emptiness
// test, so the honesty guarantee does not depend on the model reading this block.
function clientProfileSection(profileText: string): string {
  if (profileText && profileText.trim()) return profileText;
  return `CLIENT PROFILE: NONE ON FILE.
No distilled profile is available for this client (mission, core capabilities, prime_capacity/can_prime, populations). Do NOT assume any of these. Score ONLY from the CLIENT confirmed facts above:
- Treat prime_capacity.can_prime as UNKNOWN. Do NOT assign Prime on the strength of an absent profile: assign Prime only if the confirmed facts (org type, service area, eligibility) plainly support it; otherwise prefer a partner role or a conservative score, and record the missing profile in inferred_fields.
- Without a profile the functional-alignment read is inferred, so a clean 3 is rarely justified. Prefer a 2 with a caveat when the fit is real but unconfirmed; a genuine eligible fit still surfaces.`;
}

// PURE: the user message. Mirrors the occupancy path's grant/client blocks (so raw-fact parity holds) but
// drops the seat menu / ideal-profile JSON dump and ADDS the scoring-facing client profile. Exported for
// the unit test.
export function buildAlignUserContent(
  grant: Grant,
  client: Client,
  usaSpendingContext: string | undefined,
  profileText: string,
): string {
  const g = grant as Grant & {
    program_type?: string;
    subaward_prohibited?: boolean;
    scoring_criteria_high_value?: string[];
  };
  const purpose = fundedPurposeLine(grant.ideal_applicant_profile);

  const grantContext = `GRANT:
Title: ${grant.title}
Funder: ${grant.funder}
FON: ${grant.fon}
Description: ${grant.description}
${purpose ? purpose + "\n" : ""}Award Range: ${grant.award_range_min} - ${grant.award_range_max}${grant.award_range_min ? " (estimate unless the NOFO states it)" : ""}
Total Funding: ${grant.total_funding}
Deadline: ${grant.submission_deadline}
Cost Share: ${grant.cost_share}
Eligible Entity Types: ${(grant.eligible_entity_types || []).join(", ")}
Geographic Eligibility: ${grant.geographic_eligibility}
Ineligible Entities: ${grant.ineligible_entities}
Focus Areas: ${(grant.focus_areas || []).join(", ")}
Program Type: ${g.program_type || "Unknown"}
Subaward Prohibited: ${g.subaward_prohibited ? "YES -- single-applicant model only" : "No"}
Scoring Criteria (High Value): ${(g.scoring_criteria_high_value || []).join("; ")}`;

  const clientContext = `CLIENT (confirmed facts):
Name: ${client.name}
Primary Contact: ${client.primary_contact_name || "unknown"}
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
${formatSamForMatcher(client)}
Known Constraints: ${client.known_constraints || "None noted"}
Matching Rules (AUTHORITATIVE OVERRIDES -- apply before general logic): ${client.matching_rules || "None"}
Hard Constraints (CODE-ENFORCED -- authoritative; enforced in code regardless of your output, listed so your role assignment aligns):
${formatConstraintsForPrompt(client)}`;

  return `Evaluate this grant-client match.\n\n${grantContext}\n\n${clientContext}\n${clientProfileSection(profileText)}`;
}

// #105 honesty backstop, mirrored from the occupancy path (engine.ts enforceFactorDataFloors, ~693-728).
// That function is a PRIVATE local in the protected engine.ts, so this path cannot import it without touching
// the protected file -- hence a byte-faithful mirror here (locked against the occupancy version in the test).
// Forces insufficient_data on the three DATA-DEPENDENT factors when the gating client fields are blank -- a
// deterministic guarantee that a factor sub-score is never a confident guess off missing inputs, no matter
// what the model returned. Descriptive only; it never touches fit_score. Phase 2 consolidates the two copies
// when the occupancy path is deleted.
export function enforceAlignFactorDataFloors(
  fs: FactorScores | undefined,
  client: Client,
  usaSpendingContext: string | undefined,
): void {
  if (!fs) return;
  const blank = (s?: string | null) => !s || !s.trim();
  const set = (k: keyof FactorScores, rationale: string) => {
    fs[k] = { rating: "insufficient_data", rationale };
  };
  // cost_share: no budget AND no match/cost-share capacity on file.
  if (blank(client.annual_budget) && blank(client.match_cost_share_capacity)) {
    set("cost_share", "No annual budget or match/cost-share capacity on file.");
  }
  // program_history: no federal award history data of any kind (a cached "no awards found" is a REAL answer,
  // so only fire when there is no lookup data at all).
  if (
    !client.federal_history_verified &&
    !client.usaspending_summary &&
    blank(client.federal_grant_history) &&
    !usaSpendingContext
  ) {
    set("program_history", "Federal award history not on file (USASpending not checked).");
  }
  // geographic: no service area, no RUCC, and no location at all.
  if (
    (!client.service_area || client.service_area.length === 0) &&
    blank(client.rucc_codes) &&
    blank(client.location_city) &&
    blank(client.location_county) &&
    blank(client.location_state)
  ) {
    set("geographic", "No service area, RUCC, or location on file.");
  }
}

// PURE: coerce the raw model tool-input into a MatchResult, derive seat_ref from the role, apply the KEPT
// deterministic post-processing (factor-data floors + hard constraints + email sanitize), and backfill safe
// defaults so no downstream reader NPEs. Exported for the unit test. Mirrors the tail of the occupancy path's
// matchGrantToClient (minus the seat-ceiling clamp, which no longer exists).
export function finalizeAlignMatch(
  raw: Record<string, unknown>,
  client: Client,
  grant: Grant,
  usaSpendingContext?: string,
): MatchResult {
  const r = raw as Partial<MatchResult> & Record<string, unknown>;
  const result = {
    client_id: client.id,
    fit_score: clamp03(r.fit_score),
    // seat_ref/entity_required are vestigial after the replace: derived from the role for calibration's
    // seatFamily, never a scoring input.
    seat_ref: seatRefForRole(r.proposed_role as string | undefined),
    entity_required: false,
    proposed_role: (r.proposed_role as string) || "Not Recommended",
    recommended_prime: (r.recommended_prime as string | null) ?? null,
    why_this_org: Array.isArray(r.why_this_org) ? (r.why_this_org as string[]) : [],
    concept_synopsis: (r.concept_synopsis as string) ?? "",
    description_short: (r.description_short as string) ?? "",
    draft_outreach_email: (r.draft_outreach_email as string) ?? "",
    outreach_track: (r.outreach_track as "Track 1" | "Track 2") ?? "Track 1",
    before_you_approve: Array.isArray(r.before_you_approve) ? (r.before_you_approve as string[]) : [],
    inferred_fields: Array.isArray(r.inferred_fields) ? (r.inferred_fields as string[]) : [],
    reasoning_context: (r.reasoning_context as MatchResult["reasoning_context"]) ?? {
      eligibility_analysis: "",
      fit_score_derivation: "",
      role_assignment_logic: "",
      consortium_rationale: "",
      concept_derivation: "",
      why_not_others: "",
    },
    factor_scores: r.factor_scores as MatchResult["factor_scores"],
    suppressed: r.suppressed === true,
    suppress_reason: (r.suppress_reason as string | null) ?? null,
    disqualified: r.disqualified === true,
    disqualify_reason: (r.disqualify_reason as string | undefined) ?? undefined,
  } as MatchResult;

  // Honesty flag (deterministic, not model-dependent): no distilled profile was on file, so prime capacity
  // and functional fit were inferred from raw confirmed facts only. Keyed on the SAME emptiness test the
  // prompt's no-profile block uses, so the flag fires exactly when the model was told "no profile on file"
  // (a prospect via prospectAsClient carries client_profile: null; a not-yet-distilled client is the same).
  if (!formatClientProfileForScoring(client.client_profile).trim()) {
    result.before_you_approve = [
      "No distilled client profile on file: prime capacity and functional fit are inferred from raw facts only. Verify directly before outreach.",
      ...result.before_you_approve,
    ];
  }

  // KEPT verbatim from the occupancy path, in the SAME order matchGrantToClient runs them: the #105
  // factor-data honesty floor, then hard client constraints (role ceilings / funder exclusions /
  // do-not-surface -- all seat-independent), then email sanitize.
  enforceAlignFactorDataFloors(result.factor_scores, client, usaSpendingContext);
  applyHardConstraints(result, client, grant);
  // Deterministic funder cap (MATCH_FUNDER_CAP_ENABLED, default OFF). The prompt's no-go rule for a
  // can_prime=FALSE money-mover with no concrete role could not be enforced by reasoning alone (two prompt
  // iterations still handed a topical conservation-foundation-on-a-conservation-grant a consolation
  // partner-2), so code owns the CONSEQUENCE while the model owns the semantic read (is_money_mover /
  // concrete_role_on_this_grant, off the RAW tool input -- these are classification-only and never join
  // MatchResult, so no downstream reader changes). Guardrails, each load-bearing: it fires ONLY when
  //   (1) can_prime === false STRICT -- excludes null (UNKNOWN, e.g. NWA Council) and true (real implementers);
  //   (2) the model judged it a money-mover; and
  //   (3) it has NO concrete role on this grant (!== true also catches a missing/undefined flag).
  // Math.min never RAISES a score (a 0 stays 0) and caps at 1 (a Pass -- does not surface). Explainable:
  // the note is appended to fit_score_derivation. Placed AFTER hard constraints so a role_ceiling has already
  // resolved, and BEFORE the seat_ref re-derive (the cap touches fit_score only, never the role).
  if (
    matchFunderCapEnabled() &&
    client.client_profile?.prime_capacity?.can_prime === false &&
    raw.is_money_mover === true &&
    raw.concrete_role_on_this_grant !== true
  ) {
    const capped = Math.min(result.fit_score, 1) as 0 | 1 | 2 | 3;
    if (capped !== result.fit_score) {
      const prior = result.reasoning_context.fit_score_derivation ?? "";
      result.reasoning_context = {
        ...result.reasoning_context,
        fit_score_derivation:
          `${prior}${prior ? " " : ""}Funder cap: lowered ${result.fit_score}->${capped} -- ` +
          `can_prime=FALSE money-mover with no concrete role on this grant (topical/mission overlap is not a role).`,
      };
      result.fit_score = capped;
    }
  }
  // Re-derive seat_ref from the FINAL role: a role_ceiling constraint can cap Prime -> Sub, and calibration's
  // seatFamily must reflect the role the card actually carries, not the model's pre-cap proposal.
  result.seat_ref = seatRefForRole(result.proposed_role);
  result.draft_outreach_email = sanitizeOutreachEmail(result.draft_outreach_email, client.primary_contact_name);
  return result;
}

// Injectable model seam (default is the real Sonnet call). Tests pass a fake to prove the plumbing with no
// network; the eval uses the real one.
export interface AlignDeps {
  runModel?: (userContent: string) => Promise<Record<string, unknown> | null>;
}

async function realRunModel(userContent: string): Promise<Record<string, unknown> | null> {
  const anthropic = getAnthropicClient();
  const response = await anthropic.messages.create({
    model: MODEL,
    max_tokens: 8000,
    temperature: 0, // stable scoring: a borderline 2-vs-3 must not flip run to run
    system: ALIGN_SYSTEM_PROMPT,
    tools: [SUBMIT_ALIGN_TOOL],
    tool_choice: { type: "tool", name: "submit_match" },
    messages: [{ role: "user", content: userContent }],
  });
  if (response.stop_reason === "max_tokens") {
    throw new Error("Align-score response truncated at max_tokens -- raise max_tokens");
  }
  const toolUse = response.content.find((b) => b.type === "tool_use");
  if (!toolUse || toolUse.type !== "tool_use") return null;
  return toolUse.input as Record<string, unknown>;
}

// The scorer. Same signature shape as matchGrantToClient (grant, client, usaSpendingContext) so engine.ts
// can branch to it in one line. Reads client_profile via formatClientProfileForScoring (the deliberate
// #140 reversal). Throws on a missing tool call -- scoreGrantClientPair catches and records an 'error'
// attempt, exactly as it does for the occupancy path.
export async function alignScoreClient(
  grant: Grant,
  client: Client,
  usaSpendingContext?: string,
  deps: AlignDeps = {},
): Promise<MatchResult> {
  const profileText = formatClientProfileForScoring(client.client_profile);
  const userContent = buildAlignUserContent(grant, client, usaSpendingContext, profileText);
  const runModel = deps.runModel ?? realRunModel;
  const raw = await runModel(userContent);
  if (!raw) throw new Error(`Direct-align scorer returned no structured match for client ${client.name}`);
  return finalizeAlignMatch(raw, client, grant, usaSpendingContext);
}
