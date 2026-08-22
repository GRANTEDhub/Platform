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

// A grant's geographic restriction as a Set of eligible state codes -- or null when the program reads
// as NATIONAL / unrestricted or when no specific states can be detected. Deliberately CONSERVATIVE:
// it returns a restriction only when it finds specific state names AND no dominant national marker, so
// an ambiguous or national grant fails OPEN (no drop). Reads the STRUCTURED geographic_eligibility
// field; a restriction that lives only in NOFO prose the shred didn't lift here is a documented miss.
const NATIONAL_MARKERS = [
  "nationwide","national","all states","all 50 states","any state","no geographic",
  "no state restriction","unrestricted","u.s.-wide","us-wide","united states and",
];
export function grantGeoRestriction(geoText: string | null | undefined): Set<string> | null {
  const t = (geoText ?? "").toLowerCase().trim();
  if (!t) return null;
  // A bare "united states" with no state narrowing is national. (Longer phrases that ALSO name
  // specific states fall through to the scan below.)
  if (t === "united states" || t === "u.s." || t === "usa" || t === "us") return null;
  if (NATIONAL_MARKERS.some((m) => t.includes(m))) return null;

  // Match FULL state names only. A 2-letter-code scan against lowercased prose is unsafe: codes like
  // IN / OR / ME / OK / HI / OH / AL / PA / MA / DE collide with ordinary English words ("in", "or",
  // "me"...), fabricating bogus state restrictions on almost any national grant ("organizations IN the
  // United States" -> a spurious Indiana lock). Full state names don't collide, and the field is prose,
  // so names are how a real restriction reads ("Michigan and Wisconsin"). If an abbreviations-only
  // restriction ("MI, WI") ever needs catching, add an UPPERCASE-anchored code scan on the ORIGINAL
  // (un-lowercased) text -- not this one. (STATE_CODES still backs normalizeState's controlled field.)
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
  if (/\btrib|native american|indian tribe/.test(t)) return "tribal";
  if (/\bcounty\b/.test(t)) return "county";
  if (/\bcity|municipal|township|town of\b/.test(t)) return "city";
  if (/\bschool district|independent school|local education agency|\bk-12\b/.test(t)) return "school_district";
  if (/\btransit|transportation authority\b/.test(t)) return "transit_agency";
  if (/\bhospital|health system|medical center\b/.test(t)) return "hospital";
  if (/\bcollege|universit|higher education|institution of higher|\bihe\b/.test(t)) return "higher_education";
  if (/\bplanning (and|&) development district|council of governments|regional (authority|development)|special district|port authority|workforce development board|\bwdb\b/.test(t))
    return "special_district";
  if (/\bstate (government|agency|department|of )|state-level|state government-affiliated/.test(t))
    return "state_government";
  if (/\bnonprofit|non-profit|501\s*\(?c\)?|\bngo\b|charit|foundation|ministr|church|faith-based|\bassociation\b|coalition|council\b/.test(t))
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
