// Prospect eligibility backstop (PROSPECT_ELIGIBILITY_GATE_ENABLED).
//
// The problem this closes (diagnosed from real carded prospects): discovery scores each candidate
// with the SAME occupancy scorer client-matching uses and drops disqualified/sub-threshold ones --
// the eligibility logic is NOT skipped. But a discovered prospect arrives with org_type and location
// often NULL (web/awardee candidates carry thin data), and the scorer is designed to FLAG-not-KILL on
// unknown eligibility (right for a client whose data you will verify, wrong for MINTING a prospect
// card). So on missing entity/geo data the scorer INFERS eligible ("prior award implies...") and
// Gate 2 / Gate 3 never fire -- e.g. a Washington land conservancy carded fit 3 on a grant restricted
// to the Lake Superior Basin of Michigan and Wisconsin.
//
// This is a POST-SCORE, PRE-CARD backstop (deterministic, no model call) that drops a scored prospect
// whose eligibility cannot be confirmed on the two structural axes:
//   ENTITY  -- the candidate's coarse org type is known AND not among the grant's eligible PRIME types
//              (reuses deriveTargetEntityTypes, which today only gates the directory SOURCES).
//   GEO     -- the grant is restricted to specific states AND the candidate's region is either known-
//              and-outside, or UNCONFIRMED (blank) on that restricted grant.
//
// AWARDEE CARVE-OUT (deliberate, per the design decision): a USASpending past-awardee is eligible BY
// CONSTRUCTION (it won this program), so we TRUST it on ENTITY and skip the entity check -- exactly
// the same "authoritative source" trust the URL-hallucination guard already gives awardees. But we
// still FAIL an awardee on unconfirmed GEO for a geo-restricted grant: winning the general program is
// not winning its geo-locked variant (the Lake-Superior case). Trusting entity while failing on
// unconfirmed geo catches the geography error without killing legitimate awardee prospects -- and
// prospecting's whole value is surfacing orgs you don't already have, so the false-negative cost of
// over-dropping is worse than an occasional geo-slip.
//
// FAIL-OPEN is the default direction everywhere the data is ambiguous: an empty target-type set
// (deriveTargetEntityTypes degraded), an unclassifiable org_type, or a grant with no detectable geo
// restriction all yield NO drop -- byte-identical to today for those. The gate only ever drops on a
// CONFIRMED mismatch or an unconfirmed region on a clearly-restricted grant.
//
// KNOWN LIMIT (documented, not hidden): a NULL org_type on a nationally-eligible grant is below this
// gate's resolution -- there is nothing structural to check -- so a generic nonprofit inferred into a
// faith-based-only category (the "diversity center on a Houses-of-Worship grant" case) is NOT caught
// here. That distinction is finer than the coarse entity types AND (when the org is an awardee) is
// trusted by the carve-out; catching it would mean dropping the awardee entity-trust or a fragile
// name heuristic, both rejected. The scorer already marks these "inferred -- confirm," so the human
// review flag covers them. See prospect-eligibility.test.ts (the null-org_type case is asserted to
// pass, on purpose).

import type { Grant } from "@/types/database";
import type { EntityType } from "@/lib/grants/entity-types";

// The candidate fields the gate reads (a subset of discover.ts's Candidate). Exported so discover.ts
// can pass its Candidate straight through structurally.
export interface EligibilityCandidate {
  name: string;
  org_type?: string | null;
  location_state?: string | null;
  operates_in_arkansas?: boolean;
}

// ── US state normalization (for the geo check) ────────────────────────────────────────────────
const STATE_CODES = new Set([
  "AL","AK","AZ","AR","CA","CO","CT","DE","FL","GA","HI","ID","IL","IN","IA","KS","KY","LA","ME",
  "MD","MA","MI","MN","MS","MO","MT","NE","NV","NH","NJ","NM","NY","NC","ND","OH","OK","OR","PA",
  "RI","SC","SD","TN","TX","UT","VT","VA","WA","WV","WI","WY","DC",
]);
const STATE_NAME_TO_CODE: Record<string, string> = {
  alabama:"AL",alaska:"AK",arizona:"AZ",arkansas:"AR",california:"CA",colorado:"CO",connecticut:"CT",
  delaware:"DE",florida:"FL",georgia:"GA",hawaii:"HI",idaho:"ID",illinois:"IL",indiana:"IN",iowa:"IA",
  kansas:"KS",kentucky:"KY",louisiana:"LA",maine:"ME",maryland:"MD",massachusetts:"MA",michigan:"MI",
  minnesota:"MN",mississippi:"MS",missouri:"MO",montana:"MT",nebraska:"NE",nevada:"NV",
  "new hampshire":"NH","new jersey":"NJ","new mexico":"NM","new york":"NY","north carolina":"NC",
  "north dakota":"ND",ohio:"OH",oklahoma:"OK",oregon:"OR",pennsylvania:"PA","rhode island":"RI",
  "south carolina":"SC","south dakota":"SD",tennessee:"TN",texas:"TX",utah:"UT",vermont:"VT",
  virginia:"VA",washington:"WA","west virginia":"WV",wisconsin:"WI",wyoming:"WY","district of columbia":"DC",
};

// Normalize a candidate's location_state ("AR" | "Arkansas" | null) to a 2-letter code, or null.
export function normalizeState(raw: string | null | undefined): string | null {
  const s = (raw ?? "").trim();
  if (!s) return null;
  const up = s.toUpperCase();
  if (STATE_CODES.has(up)) return up;
  const code = STATE_NAME_TO_CODE[s.toLowerCase()];
  return code ?? null;
}

// A grant's geographic restriction as a Set of eligible state codes -- or null when no specific states
// can be detected (national / unrestricted / ambiguous all fail OPEN, no drop). Reads the STRUCTURED
// geographic_eligibility field; a restriction that lives only in NOFO prose the shred didn't lift here
// is a documented miss.
export function grantGeoRestriction(geoText: string | null | undefined): Set<string> | null {
  const t = (geoText ?? "").toLowerCase().trim();
  if (!t) return null;

  // Scan for specific FULL state names, and let a real state restriction WIN over national-sounding
  // language: "a nationally competitive program limited to Michigan and Wisconsin" is restricted to
  // MI/WI, so a "national"/"nationwide" word must not short-circuit it. If no specific state is named,
  // the grant is unrestricted for our purposes -> null (that subsumes every "nationwide"/"all states"
  // marker, so no separate marker list is needed, and no substring like "national" inside "nationally"
  // can mislead). FULL NAMES only -- a 2-letter-code scan against lowercased prose collides with
  // ordinary English words (in->IN, or->OR, me->ME...); an abbreviations-only restriction ("MI, WI")
  // would need an UPPERCASE-anchored scan on the ORIGINAL text, not this one. (STATE_CODES still backs
  // normalizeState's controlled field.)
  const found = new Set<string>();
  for (const [name, code] of Object.entries(STATE_NAME_TO_CODE)) {
    if (new RegExp(`\\b${name}\\b`).test(t)) found.add(code);
  }
  return found.size > 0 ? found : null;
}

// ── Coarse org-type classification (for the entity check) ─────────────────────────────────────
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
// to card it. Pure and deterministic (no DB, no model call), so discover.ts can wrap it in the flag
// and unit tests can exercise every branch with constructed fixtures. `targetTypes` is the already-
// computed deriveTargetEntityTypes(grant); `isAwardee` is whether this candidate came from the
// USASpending past-awardee source (eligible-by-construction -> entity trusted).
export function prospectEligibilityDrop(
  candidate: EligibilityCandidate,
  grant: Pick<Grant, "geographic_eligibility">,
  targetTypes: EntityType[],
  isAwardee: boolean,
): string | null {
  // GEO check first -- applies to ALL sources, awardees included (the carve-out trusts entity, not geo).
  const restrict = grantGeoRestriction(grant.geographic_eligibility);
  if (restrict) {
    const st = normalizeState(candidate.location_state);
    if (st) {
      if (!restrict.has(st)) {
        return `geo: ${st} outside grant restriction [${[...restrict].join("/")}]`;
      }
    } else if (candidate.operates_in_arkansas === true) {
      // Known-AR org, but the grant excludes AR.
      if (!restrict.has("AR")) return `geo: Arkansas org, grant restricted to [${[...restrict].join("/")}]`;
    } else {
      // Region entirely unconfirmed on a geo-restricted grant -> cannot confirm eligibility. This is
      // the awardee-inclusive leg: winning the general program is not winning its geo-locked variant.
      return `geo: region unconfirmed on grant restricted to [${[...restrict].join("/")}]`;
    }
  }

  // ENTITY check -- SKIPPED for awardees (trusted by construction). Fails open on an empty target set
  // or an unclassifiable org_type.
  if (!isAwardee && targetTypes.length > 0) {
    const t = classifyOrgType(candidate.org_type);
    if (t && !targetTypes.includes(t)) {
      return `entity: ${t} not among eligible prime types [${targetTypes.join(",")}]`;
    }
  }

  return null;
}
