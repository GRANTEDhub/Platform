// Community need-context from the U.S. Census ACS 5-year estimates, resolved at the
// most specific level the client's stored location allows. We store only city/county/
// state NAMES (no street address), so this resolves place- and county-level indicators
// by name; tract-level precision (and the HRSA/HUD/EJ overlays) awaits a street-address
// field + the Census geocoder.
//
// Mirrors the prospecting sources (lib/grants/directories.ts): every fetch degrades to
// null/[] on ANY failure (missing key, network, shape change) so enrichment never breaks
// and simply omits the section. source_url (data.census.gov) is the authoritative record.

import type { Client, CommunityContext, CommunityGeography, CommunityIndicators } from "@/types/database";
import { stateFips } from "@/lib/geo/us-fips";

const ACS_VINTAGE = "2022"; // matches the prospecting enumeration vintage
const ACS_BASE = `https://api.census.gov/data/${ACS_VINTAGE}/acs/acs5`;
const TIMEOUT_MS = 15000;

// ACS detail variables (verified against the ACS5 2022 variables catalog). Rates are
// derived from the raw counts below, never taken as a single "percent" variable.
const VARS = {
  population: "B01003_001E",
  medianIncome: "B19013_001E",
  povertyUniverse: "B17001_001E",
  povertyBelow: "B17001_002E",
  laborForce: "B23025_003E",
  unemployed: "B23025_005E",
} as const;
const VAR_LIST = Object.values(VARS).join(",");

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

// ACS encodes "not available" as large negative sentinels (e.g. -666666666). Treat any
// negative or non-finite value as null so a sentinel never surfaces as real data.
function acsNum(v: unknown): number | null {
  const n = typeof v === "number" ? v : Number(String(v ?? "").trim());
  if (!Number.isFinite(n) || n < 0) return null;
  return n;
}

// numerator/denominator as a 0-100 percent to one decimal; null if either is missing.
function rate(numerator: number | null, denominator: number | null): number | null {
  if (numerator == null || denominator == null || denominator <= 0) return null;
  return Math.round((numerator / denominator) * 1000) / 10;
}

function toIndicators(get: (v: string) => unknown): CommunityIndicators {
  return {
    population: acsNum(get(VARS.population)),
    median_household_income: acsNum(get(VARS.medianIncome)),
    poverty_rate: rate(acsNum(get(VARS.povertyBelow)), acsNum(get(VARS.povertyUniverse))),
    unemployment_rate: rate(acsNum(get(VARS.unemployed)), acsNum(get(VARS.laborForce))),
  };
}

// Drop everything after a comma, strip the trailing government-type word, lowercase.
// "Pulaski County, Arkansas" -> "pulaski"; "Little Rock city, Arkansas" -> "little rock".
const COUNTY_SUFFIX = /\s+(county|parish|borough|census area|municipality|city and borough)$/i;
const PLACE_SUFFIX = /\s+(city|town|village|borough|municipality|cdp)$/i;
function norm(s: string, suffix: RegExp): string {
  return s.split(",")[0].replace(suffix, "").trim().toLowerCase();
}

// Fetch every geography of `level` in the state (indicators + NAME in one call), match
// the client's name, and build the CommunityGeography. Null on any failure or no match.
async function fetchLevel(
  level: "county" | "place",
  fips: string,
  state2: string,
  wantName: string,
  key: string,
): Promise<CommunityGeography | null> {
  const url = `${ACS_BASE}?get=NAME,${VAR_LIST}&for=${level}:*&in=state:${fips}&key=${encodeURIComponent(key)}`;
  const data = (await getJson(url)) as string[][] | null;
  if (!Array.isArray(data) || data.length < 2) return null;

  const header = data[0];
  const nameIdx = header.indexOf("NAME");
  const codeIdx = header.indexOf(level); // trailing column holds the county/place FIPS
  if (nameIdx < 0 || codeIdx < 0) return null;

  const suffix = level === "county" ? COUNTY_SUFFIX : PLACE_SUFFIX;
  const target = norm(wantName, suffix);
  if (!target) return null;

  for (const row of data.slice(1)) {
    if (norm(String(row[nameIdx] ?? ""), suffix) !== target) continue;
    const code = String(row[codeIdx] ?? "").trim();
    if (!code) return null;
    const geoid = level === "county" ? `0500000US${fips}${code}` : `1600000US${fips}${code}`;
    return {
      level,
      name: String(row[nameIdx]).split(",")[0].trim(),
      state: state2,
      geoid,
      indicators: toIndicators((v) => row[header.indexOf(v)]),
      source_url: `https://data.census.gov/profile?g=${geoid}`,
    };
  }
  return null;
}

// Build community need-context for a client. Resolves place- (city) and county-level
// indicators in parallel from the names on file. Fail-safe: returns null if the key is
// missing, the state is unknown, or nothing resolves; never throws into the caller.
export async function buildCommunityContext(client: Client): Promise<CommunityContext | null> {
  const key = process.env.CENSUS_API_KEY;
  const fips = stateFips(client.location_state);
  if (!key || !fips) return null;
  const state2 = String(client.location_state).trim().toUpperCase();

  const jobs: Promise<CommunityGeography | null>[] = [];
  if (client.location_city?.trim()) {
    jobs.push(fetchLevel("place", fips, state2, client.location_city, key).catch(() => null));
  }
  if (client.location_county?.trim()) {
    jobs.push(fetchLevel("county", fips, state2, client.location_county, key).catch(() => null));
  }
  if (jobs.length === 0) return null;

  const resolved = (await Promise.all(jobs)).filter((g): g is CommunityGeography => g != null);
  if (resolved.length === 0) return null;

  const rank = (g: CommunityGeography) => (g.level === "place" ? 0 : 1); // place first
  resolved.sort((a, b) => rank(a) - rank(b));
  return { checked_at: new Date().toISOString(), source: "US Census ACS 5-year", vintage: ACS_VINTAGE, geographies: resolved };
}
