// Prospect eligibility backstop (PROSPECT_ELIGIBILITY_GATE_ENABLED).
//
// The problem this closes (diagnosed from real carded prospects): discovery scores each candidate
// with the SAME occupancy scorer client-matching uses and drops disqualified/sub-threshold ones --
// the eligibility logic is NOT skipped. But a discovered prospect arrives with org_type and location
// often NULL (web/awardee candidates carry thin data), and the scorer is designed to FLAG-not-KILL on
// unknown eligibility (right for a client whose data you will verify, wrong for MINTING a prospect
// card). So on missing data the scorer INFERS eligible and Gate 2 / Gate 3 never fire -- e.g. a
// Washington land conservancy carded fit 3 on a grant restricted to the Lake Superior Basin of
// Michigan and Wisconsin.
//
// This is a POST-SCORE, PRE-CARD backstop (deterministic, no model call) that drops a scored prospect
// on two structural axes:
//
//   GEO (rework) -- CIRCULAR-INFERENCE detection, not a field re-parse. The earlier version re-parsed
//     the grant's geographic_eligibility text into a state Set and compared the candidate's location.
//     That was the WRONG mechanism: the scorer's own Gate 3 already drops a KNOWN out-of-region org
//     (its match is disqualified before this gate runs), and the free-text parse was a bug farm (2-letter
//     collisions, "District of Columbia" boilerplate, "West Virginia" compounds, exclusion inversion).
//     The real failure mode is narrower: the scorer had NO location signal and back-filled one FROM THE
//     GRANT ("service area inferred as the Upper Great Lakes region based on the program / prior awards
//     under this program") -- a tautology, so Gate 3 passed on a fabricated location and the card minted.
//     We drop exactly that: a location inferred_field whose stated basis is the GRANT (program name /
//     prior awards / eligible region). A location inferred from the ORG'S OWN NAME ("Western New York
//     Land Conservancy" -> NY; "Diversity Center of Oklahoma" -> OK) is legitimate grounding and is KEPT.
//     Reads the scorer's OWN admission (match.inferred_fields), so it is grounded in how the score was
//     actually reached, not a second independent guess about the grant's geography.
//
//   ENTITY -- the candidate's coarse org type is known AND not among the grant's eligible PRIME types
//     (reuses deriveTargetEntityTypes). SKIPPED for a genuine SUB (see the #414 coupling below).
//
// AWARDEE CARVE-OUT (unchanged in intent): a USASpending past-awardee is eligible BY CONSTRUCTION on
// ENTITY (it won this program) so the entity check is skipped for it -- but GEO still applies (winning
// the general program is not winning its geo-locked variant). In practice awardees carry a KNOWN
// location_state, so they have no inferred location field and the circular-inference drop never fires
// on them anyway; the geo check applies to all sources uniformly.
//
// #414 COUPLING (explicit): discovery scores through matchGrantToClient, which now runs supporting-seat
// routing (MATCH_SUBSEAT_ROUTING_ENABLED, ON in prod). So a discovered prospect can come back routed to
// a SUPPORTING seat (seat_ref S*, role Sub / Co-Applicant) -- eligible AS A SUB. deriveTargetEntityTypes
// returns PRIME types only, so measuring a genuine Sub against them would WRONGLY drop it and undo the
// sub-routing win. The entity check therefore EXEMPTS a sub-routed prospect.
//
// FAIL-OPEN everywhere data is ambiguous: no location inference (or an org-grounded one), an empty
// target-type set, or an unclassifiable org_type all yield NO drop -- byte-identical to today for those.
// Over-dropping is the worse error for prospecting (its whole value is surfacing orgs you don't already
// have), so the gate drops only on a CLEAR circular inference or a CONFIRMED entity mismatch.
//
// KNOWN LIMIT (documented, not hidden): a NULL org_type on a nationally-eligible grant is below this
// gate's resolution -- nothing structural to check, no location inference to catch -- so a generic
// nonprofit inferred into a faith-based-only category (the "diversity center on a Houses-of-Worship
// grant" case) is NOT caught here. The scorer already marks these "inferred -- confirm"; the human
// review flag covers them. Asserted to pass, on purpose, in prospect-eligibility.test.ts.

import type { EntityType } from "@/lib/grants/entity-types";
import { seatFamily } from "@/lib/grants/calibration";

// The candidate fields the gate reads (a subset of discover.ts's Candidate). Exported so discover.ts
// can pass its Candidate straight through structurally.
export interface EligibilityCandidate {
  name: string;
  org_type?: string | null;
}

// The scorer signals the gate reads off the MatchResult (a subset, so a test can build one directly and
// discover.ts can pass its match straight through structurally). inferred_fields is the scorer's OWN
// list of which fields it had to infer and on what basis; seat_ref / proposed_role carry the (possibly
// sub-routed) seat.
export interface MatchSignals {
  inferred_fields?: string[] | null;
  seat_ref?: string | null;
  proposed_role?: string | null;
}

// ── Circular-location detection (the GEO axis) ────────────────────────────────────────────────
// A location/service-area inferred_field whose stated basis is the GRANT itself is CIRCULAR: the scorer
// had no independent signal of where the org operates and back-filled it from the grant, so "in the
// eligible region" is a tautology. One grounded in the ORG'S OWN NAME/identity is legitimate. Only a
// field that is ABOUT location counts; a non-geographic inference (e.g. an inferred budget) is ignored.
const LOCATION_FIELD = /\b(location|service\s*area|geograph|operat\w*\s+in|based\s+in|headquarter|jurisdiction)\b/;
const CIRCULAR_BASIS =
  /\b(program\s+name|program'?s\b|prior\s+award|past\s+award|under\s+this\s+(program|grant|nofo)|this\s+program'?s?\b|eligible\s+(region|area|state|geograph)|grant'?s?\s+(region|area|geograph|eligib)|awardees?\s+(of|under)\s+this)\b/;
// ORG-grounded must reference the ORGANIZATION's name specifically -- NOT a bare "... name", because
// the circular basis "based on the PROGRAM name" also contains the word "name"; a generic name-catch
// would swallow the circular case and never drop it.
const ORG_GROUNDED_BASIS =
  /\b(organization'?s?\s+name|org\s+name|its\s+(own\s+)?name|the\s+(org|organization|firm|entity|nonprofit)'?s?\s+name|name\s+of\s+the\s+(org|organization|nonprofit|firm|entity)|name\s+(suggests|indicates|implies|contains)|self-identif)/;

// True when the prospect's location was CIRCULARLY inferred from the grant (region unconfirmed). Errs
// toward KEEPING: fires only on a clear grant-grounded basis with no org-name grounding present.
// Exported for deterministic unit testing.
export function circularLocationInference(inferredFields: string[] | null | undefined): boolean {
  for (const raw of inferredFields ?? []) {
    if (!raw) continue;
    // Normalize Unicode curly apostrophes (U+2018/U+2019) to ASCII so the possessive patterns below
    // (which only match U+0027) fire on free-form LLM output like "organization’s name". Without this,
    // a curly-apostrophe ORG_GROUNDED basis fails to match and, in an ambiguous string, the gate would
    // wrongly DROP a legitimate prospect — the worse error direction.
    const t = raw.toLowerCase().replace(/[‘’]/g, "'");
    if (!LOCATION_FIELD.test(t)) continue; // not a location inference → irrelevant to geo
    if (CIRCULAR_BASIS.test(t) && !ORG_GROUNDED_BASIS.test(t)) return true; // clear circular → drop
  }
  return false; // no location inference, org-grounded, or ambiguous → keep (fail open)
}

// ── Coarse org-type classification (the ENTITY axis) ─────────────────────────────────────────
// Map a candidate's FREE-TEXT org_type to a coarse EntityType, or null when it cannot be classified
// (in which case the entity check fails OPEN -- no drop). Keyword-based and deterministic; mirrors
// the coarseness of deriveTargetEntityTypes (which is what we compare against). Order matters: more
// specific government / institutional types are tested before the broad "nonprofit" fallback.
export function classifyOrgType(orgType: string | null | undefined): EntityType | null {
  const t = (orgType ?? "").toLowerCase();
  if (!t.trim()) return null;
  // EVERY alternation branch must be bounded on BOTH sides where a bare prefix would collide with a
  // longer word: `\btransit` matches "transitional", `\bhospital` matches "hospitality", `\btrib`
  // matches "tribute"/"tribunal" -- and because these branches return BEFORE the nonprofit fallback, a
  // misclassification would DROP a genuinely eligible nonprofit. (`|` binds looser than `\b`, so an
  // anchor on only the first branch does not carry to the rest.)
  if (/\btrib(?:e|es|al)\b|native american|indian tribe/.test(t)) return "tribal";
  if (/\bcounty\b/.test(t)) return "county";
  if (/\bcity\b|\bmunicipal(?:ity)?\b|\btownship\b|\btown of\b/.test(t)) return "city";
  if (/\bschool district\b|independent school|local education agency|\bk-12\b/.test(t)) return "school_district";
  if (/\btransit\b|transit authorit|transit agenc|transportation authorit/.test(t)) return "transit_agency";
  if (/\bhospitals?\b|health system|medical center/.test(t)) return "hospital";
  if (/\bcolleges?\b|universit|higher education|institution of higher|\bihe\b/.test(t)) return "higher_education";
  if (/\bplanning (and|&) development district|council of governments|regional (authority|development)|special district|port authority|workforce development board|\bwdb\b/.test(t))
    return "special_district";
  if (/\bstate (government|agency|department|of )|state-level|state government-affiliated/.test(t))
    return "state_government";
  if (/\bnonprofit\b|non-profit|501\s*\(?c\)?|\bngo\b|charit|foundation|ministr|church|faith-based|\bassociation\b|coalition|\bcouncil\b/.test(t))
    return "nonprofit";
  return null;
}

// The gate. Returns a short drop-reason string when the scored prospect should NOT be carded, or null
// to card it. Pure and deterministic (no DB, no model call). `targetTypes` is the already-computed
// deriveTargetEntityTypes(grant); `isAwardee` is whether this candidate came from the USASpending
// past-awardee source (eligible-by-construction -> entity trusted); `match` carries the scorer's own
// inferred_fields + (possibly sub-routed) seat.
export function prospectEligibilityDrop(
  candidate: EligibilityCandidate,
  targetTypes: EntityType[],
  isAwardee: boolean,
  match: MatchSignals,
): string | null {
  // GEO -- circular-inference drop, applied to ALL sources (geo is never trusted-by-construction).
  if (circularLocationInference(match.inferred_fields)) {
    return "geo: location circularly inferred from the grant (region unconfirmed)";
  }

  // ENTITY -- SKIPPED for awardees (trusted by construction) AND for a genuine SUB (the #414 coupling:
  // a prospect the scorer routed to a supporting seat is eligible as a sub, not measured against
  // prime-only types). Fails open on an empty target set or an unclassifiable org_type.
  const subRouted = seatFamily(match.seat_ref) === "supporting" || /sub|co-applicant/i.test(match.proposed_role ?? "");
  if (!isAwardee && !subRouted && targetTypes.length > 0) {
    const t = classifyOrgType(candidate.org_type);
    if (t && !targetTypes.includes(t)) {
      return `entity: ${t} not among eligible prime types [${targetTypes.join(",")}]`;
    }
  }

  return null;
}
