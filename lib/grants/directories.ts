// Phase 2 prospecting enumeration sources for the non-nonprofit PRIME types, routed by
// entity type (see lib/grants/entity-types.ts). Each source enumerates real orgs of one
// type in a given U.S. state from a free public dataset:
//   - higher_education -> U.S. Dept. of Education College Scorecard (IPEDS)
//   - hospital         -> CMS Provider Data Catalog (Hospital General Information)
//   - transit_agency   -> FTA National Transit Database (Socrata)
//   - city / county    -> U.S. Census Bureau API (ACS 5-year name enumeration)
//
// Mirrors lib/grants/eo-directory.ts: every source degrades to [] on ANY failure (bad
// key, network, shape change) so discovery never 500s and simply surfaces fewer
// candidates; source_url is the authoritative public record. findTypedDirectoryOrgs()
// fans out to only the sources whose entity type is among the grant's targeted primes.
//
// AR-focused for now (GRANTED's home market and where its gov/college/transit/health
// clients concentrate), matching the nonprofit directory. National expansion = later.

import type { EntityType } from "./entity-types";

export interface TypedOrg {
  name: string;
  city: string | null;
  state: string; // 2-letter
  source_url: string;
  org_type: string; // human label stored on the prospect record
  capability_summary: string;
  entity_type: EntityType;
}

const TIMEOUT_MS = 15000;

// Small JSON GET with an abort timeout; returns null on any non-OK / error so each
// source can degrade to [] cleanly.
async function getJson(url: string): Promise<unknown | null> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: controller.signal, headers: { Accept: "application/json" } });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

function titleCase(s: string): string {
  return s
    .toLowerCase()
    .split(/\s+/)
    .map((w) => (w ? w.charAt(0).toUpperCase() + w.slice(1) : w))
    .join(" ");
}

// ── higher_education: College Scorecard (IPEDS) ──────────────────────────────
// Free; needs an api.data.gov key (COLLEGE_SCORECARD_API_KEY). Filter school.state; the
// result keys are the flat dotted field names requested. id = IPEDS UNITID (stable).
async function findColleges(state: string): Promise<TypedOrg[]> {
  const key = process.env.COLLEGE_SCORECARD_API_KEY;
  if (!key) return []; // no key configured -> skip this source (graceful)
  const fields = "id,school.name,school.city,school.state,school.ownership,school.degrees_awarded.predominant";
  const url =
    `https://api.data.gov/ed/collegescorecard/v1/schools?api_key=${encodeURIComponent(key)}` +
    `&school.state=${encodeURIComponent(state)}&fields=${fields}&per_page=100`;
  const data = (await getJson(url)) as { results?: Record<string, unknown>[] } | null;
  const rows = data?.results ?? [];
  const out: TypedOrg[] = [];
  for (const r of rows) {
    const name = String(r["school.name"] ?? "").trim();
    const unitid = r["id"];
    if (!name || unitid == null) continue;
    const city = (r["school.city"] as string) || null;
    const twoYear = r["school.degrees_awarded.predominant"] === 2;
    const isPublic = r["school.ownership"] === 1;
    const kind = twoYear ? "community/2-year college" : "college or university";
    const owner = isPublic ? "public" : "private";
    out.push({
      name,
      city,
      state,
      source_url: `https://nces.ed.gov/collegenavigator/?id=${unitid}`,
      org_type: twoYear ? "Community college" : "College / university",
      capability_summary:
        `${titleCase(owner)} ${kind}${city ? ` in ${city}, ${state}` : ` in ${state}`} (IPEDS UNITID ${unitid}), ` +
        `from the U.S. Dept. of Education College Scorecard. Program capability not independently verified.`,
      entity_type: "higher_education",
    });
  }
  return out;
}

// ── hospital: CMS Provider Data Catalog (Hospital General Information) ────────
// Free, no key. facility_id = CMS CCN (stable). Facility-level (not parent health system).
async function findHospitals(state: string): Promise<TypedOrg[]> {
  const url =
    `https://data.cms.gov/provider-data/api/1/datastore/query/xubh-q36u/0?limit=800` +
    `&conditions[0][property]=state&conditions[0][operator]=%3D&conditions[0][value]=${encodeURIComponent(state)}`;
  const data = (await getJson(url)) as { results?: Record<string, unknown>[] } | null;
  const rows = data?.results ?? [];
  const out: TypedOrg[] = [];
  for (const r of rows) {
    const name = String(r["facility_name"] ?? "").trim();
    const ccn = String(r["facility_id"] ?? "").trim();
    if (!name || !ccn) continue;
    const city = (r["citytown"] as string) ? titleCase(String(r["citytown"])) : null;
    const ownership = (r["hospital_ownership"] as string) || null;
    const type = (r["hospital_type"] as string) || "hospital";
    out.push({
      name: titleCase(name),
      city,
      state,
      source_url: `https://www.medicare.gov/care-compare/details/hospital/${ccn}`,
      org_type: "Hospital / health system",
      capability_summary:
        `${type}${city ? ` in ${city}, ${state}` : ` in ${state}`} (CMS CCN ${ccn}${ownership ? `, ${ownership.toLowerCase()}` : ""}), ` +
        `from the CMS Provider Data Catalog. Facility-level record; program capability not independently verified.`,
      entity_type: "hospital",
    });
  }
  return out;
}

// ── transit_agency: FTA National Transit Database (Socrata) ──────────────────
// Free, no key. Service-by-Agency table (6y83-7vuw): agency + max_city + max_state +
// _5_digit_ntd_id. Multiple rows per agency (per service/mode) -> dedup by NTD id.
async function findTransit(state: string): Promise<TypedOrg[]> {
  const url =
    `https://data.transportation.gov/resource/6y83-7vuw.json?max_state=${encodeURIComponent(state)}&$limit=500`;
  const rows = ((await getJson(url)) as Record<string, unknown>[] | null) ?? [];
  const byId = new Map<string, TypedOrg>();
  for (const r of rows) {
    const name = String(r["agency"] ?? "").trim();
    const id = String(r["_5_digit_ntd_id"] ?? r["ntd_id"] ?? "").trim();
    if (!name || !id || byId.has(id)) continue;
    const city = (r["max_city"] as string) ? titleCase(String(r["max_city"])) : null;
    byId.set(id, {
      name,
      city,
      state,
      source_url: `https://data.transportation.gov/resource/6y83-7vuw.json?_5_digit_ntd_id=${encodeURIComponent(id)}`,
      org_type: "Public transit agency",
      capability_summary:
        `Public transit agency${city ? ` in ${city}, ${state}` : ` in ${state}`} (NTD ID ${id}), ` +
        `from the FTA National Transit Database. Program capability not independently verified.`,
      entity_type: "transit_agency",
    });
  }
  return Array.from(byId.values());
}

// ── city / county: U.S. Census Bureau API ────────────────────────────────────
// Free; needs CENSUS_API_KEY. Enumerates named geographies (ACS5 2022). The Census API
// returns a 2-D array with a header row. For places we keep only INCORPORATED
// municipalities (name ends " city/town/village/borough") and drop CDPs (Census
// Designated Places -- named communities with NO government, so nothing to prospect).
const STATE_FIPS: Record<string, string> = {
  AL: "01", AK: "02", AZ: "04", AR: "05", CA: "06", CO: "08", CT: "09", DE: "10",
  DC: "11", FL: "12", GA: "13", HI: "15", ID: "16", IL: "17", IN: "18", IA: "19",
  KS: "20", KY: "21", LA: "22", ME: "23", MD: "24", MA: "25", MI: "26", MN: "27",
  MS: "28", MO: "29", MT: "30", NE: "31", NV: "32", NH: "33", NJ: "34", NM: "35",
  NY: "36", NC: "37", ND: "38", OH: "39", OK: "40", OR: "41", PA: "42", RI: "44",
  SC: "45", SD: "46", TN: "47", TX: "48", UT: "49", VT: "50", VA: "51", WA: "53",
  WV: "54", WI: "55", WY: "56",
};

async function fetchCensus(level: "county" | "place", stateFips: string, key: string): Promise<string[][]> {
  const url =
    `https://api.census.gov/data/2022/acs/acs5?get=NAME&for=${level}:*&in=state:${stateFips}&key=${encodeURIComponent(key)}`;
  const data = (await getJson(url)) as string[][] | null;
  // First row is the header ([NAME, state, <level>]); drop it.
  return Array.isArray(data) && data.length > 1 ? data.slice(1) : [];
}

async function findCounties(state: string): Promise<TypedOrg[]> {
  const key = process.env.CENSUS_API_KEY;
  const fips = STATE_FIPS[state];
  if (!key || !fips) return [];
  const rows = await fetchCensus("county", fips, key);
  const out: TypedOrg[] = [];
  for (const row of rows) {
    const full = String(row[0] ?? ""); // "Pulaski County, Arkansas"
    const county = full.split(",")[0]?.trim();
    const countyFips = String(row[2] ?? "").trim();
    if (!county || !countyFips) continue;
    const geoid = `0500000US${fips}${countyFips}`;
    out.push({
      name: county,
      city: null,
      state,
      source_url: `https://data.census.gov/profile?g=${geoid}`,
      org_type: "County government",
      capability_summary:
        `County government (${county}, ${state}), from the U.S. Census Bureau. ` +
        `Enumerated as a candidate applicant; program capability not independently verified.`,
      entity_type: "county",
    });
  }
  return out;
}

async function findMunicipalities(state: string): Promise<TypedOrg[]> {
  const key = process.env.CENSUS_API_KEY;
  const fips = STATE_FIPS[state];
  if (!key || !fips) return [];
  const rows = await fetchCensus("place", fips, key);
  const out: TypedOrg[] = [];
  for (const row of rows) {
    const full = String(row[0] ?? ""); // "Little Rock city, Arkansas" | "X CDP, Arkansas"
    const placeFips = String(row[2] ?? "").trim();
    const namePart = full.split(",")[0]?.trim() ?? "";
    // Keep incorporated governments only; drop CDPs (no government to pitch).
    const m = namePart.match(/\s+(city|town|village|borough)$/i);
    if (!m || m.index == null || !placeFips) continue;
    const name = namePart.slice(0, m.index).trim();
    if (!name) continue;
    const geoid = `1600000US${fips}${placeFips}`;
    out.push({
      name,
      city: name,
      state,
      source_url: `https://data.census.gov/profile?g=${geoid}`,
      org_type: "City / municipal government",
      capability_summary:
        `Incorporated ${m[1].toLowerCase()} government (${name}, ${state}), from the U.S. Census Bureau. ` +
        `Enumerated as a candidate applicant; program capability not independently verified.`,
      entity_type: "city",
    });
  }
  return out;
}

// One source per (set of) entity type(s). Discovery runs only the sources whose type is
// among the grant's targeted primes.
const SOURCES: { types: EntityType[]; run: (state: string) => Promise<TypedOrg[]> }[] = [
  { types: ["higher_education"], run: findColleges },
  { types: ["hospital"], run: findHospitals },
  { types: ["transit_agency"], run: findTransit },
  { types: ["county"], run: findCounties },
  { types: ["city"], run: findMunicipalities },
];

// Fan out to the sources matching the targeted prime types, in parallel; each degrades
// to [] on failure so one bad source never sinks the run.
export async function findTypedDirectoryOrgs(targetTypes: EntityType[], state: string): Promise<TypedOrg[]> {
  const want = new Set<EntityType>(targetTypes);
  const runs = SOURCES.filter((s) => s.types.some((t) => want.has(t))).map((s) =>
    s.run(state).catch(() => [] as TypedOrg[]),
  );
  if (runs.length === 0) return [];
  const results = await Promise.all(runs);
  return results.flat();
}
