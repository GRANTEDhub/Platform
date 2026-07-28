// Community need-context from the U.S. Census ACS 5-year estimates, resolved at the
// most specific level the client's stored location allows. We store only city/county/
// state NAMES (no street address), so this resolves place- and county-level indicators
// by name; tract-level precision (and the HRSA/HUD/EJ overlays) awaits a street-address
// field + the Census geocoder.
//
// Mirrors the prospecting sources (lib/grants/directories.ts): every fetch degrades to
// null/[] on ANY failure (missing key, network, shape change) so enrichment never breaks
// and simply omits the section. source_url (data.census.gov) is the authoritative record.

import type { Client, CommunityContext, CommunityGeography, CommunityIndicators, Geocode } from "@/types/database";
import { stateFips } from "@/lib/geo/us-fips";
import { lookupShortageAreas } from "@/lib/geo/hrsa";
import { lookupHudDesignations } from "@/lib/geo/hud";

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

// ── Census Geocoder: street address -> point + tract GEOID ───────────────────
// Keyless. The join key for the tract-level overlays (HRSA, and later HUD/EJ). Only
// a full STREET address resolves ("Little Rock, AR" returns no match), which is why
// clients carry location_street. "Public_AR_Current" = Public Address Ranges (national,
// NOT Arkansas). Fail-safe: null on no street / no match / bad shape.
const GEOCODER_ONELINE =
  "https://geocoding.geo.census.gov/geocoder/geographies/onelineaddress";

async function geocodeAddress(oneline: string): Promise<Geocode | null> {
  const url =
    `${GEOCODER_ONELINE}?address=${encodeURIComponent(oneline)}` +
    `&benchmark=Public_AR_Current&vintage=Census2020_Current&format=json`;
  const data = (await getJson(url)) as
    | { result?: { addressMatches?: Array<Record<string, unknown>> } }
    | null;
  const match = data?.result?.addressMatches?.[0] as
    | {
        coordinates?: { x?: number; y?: number };
        matchedAddress?: string;
        geographies?: Record<string, Array<Record<string, unknown>>>;
      }
    | undefined;
  if (!match) return null;
  const lon = Number(match.coordinates?.x);
  const lat = Number(match.coordinates?.y);
  const tract = match.geographies?.["Census Tracts"]?.[0];
  const geoid = tract?.["GEOID"];
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || !geoid) return null;
  return {
    lat,
    lon,
    tract_geoid: String(geoid),
    state_fips: String(tract?.["STATE"] ?? ""),
    county_fips: String(tract?.["COUNTY"] ?? ""),
    tract_code: String(tract?.["TRACT"] ?? ""),
    matched_address: String(match.matchedAddress ?? oneline),
    source: "US Census Geocoder",
  };
}

// Assemble the one-line address from the client's stored fields and geocode it. Null
// when there is no street on file (v1 requires street precision for the overlays).
async function geocodeClient(client: Client): Promise<Geocode | null> {
  if (!client.location_street?.trim()) return null;
  const oneline = [client.location_street, client.location_city, client.location_state, client.location_zip]
    .map((p) => (typeof p === "string" ? p.trim() : ""))
    .filter(Boolean)
    .join(", ");
  return geocodeAddress(oneline);
}

// Build community need-context for a client. Resolves place- (city) and county-level
// ACS indicators by name AND geocodes the street address (for the tract join key),
// all concurrently. Fail-safe: returns null only if nothing at all resolves; never
// throws into the caller. The geocode is plumbing -- it is not rendered into narrative.
export async function buildCommunityContext(client: Client): Promise<CommunityContext | null> {
  const key = process.env.CENSUS_API_KEY;
  const fips = stateFips(client.location_state);
  const state2 = client.location_state ? String(client.location_state).trim().toUpperCase() : null;

  const geoJobs: Promise<CommunityGeography | null>[] = [];
  if (key && fips && state2) {
    if (client.location_city?.trim()) {
      geoJobs.push(fetchLevel("place", fips, state2, client.location_city, key).catch(() => null));
    }
    if (client.location_county?.trim()) {
      geoJobs.push(fetchLevel("county", fips, state2, client.location_county, key).catch(() => null));
    }
  }

  // Geocode is keyless and runs regardless of the ACS key. The point-based overlays
  // (HRSA shortage areas + HUD QCT/DDA) depend on the resulting point, so they chain
  // off the geocode and run concurrently with each other; the whole chain runs
  // concurrently with the ACS geography fetches. All fail-safe.
  const geoPointPromise = (async () => {
    const geocode = await geocodeClient(client).catch(() => null);
    if (!geocode) return { geocode: null, shortage: null, hud: null };
    const [shortage, hud] = await Promise.all([
      lookupShortageAreas(geocode.lat, geocode.lon).catch(() => null),
      lookupHudDesignations(geocode.lat, geocode.lon).catch(() => null),
    ]);
    return { geocode, shortage, hud };
  })();
  const [{ geocode, shortage, hud }, geos] = await Promise.all([geoPointPromise, Promise.all(geoJobs)]);

  const resolved = geos.filter((g): g is CommunityGeography => g != null);
  const rank = (g: CommunityGeography) => (g.level === "place" ? 0 : 1); // place first
  resolved.sort((a, b) => rank(a) - rank(b));

  if (resolved.length === 0 && !geocode) return null;
  return {
    checked_at: new Date().toISOString(),
    source: "US Census ACS 5-year",
    vintage: ACS_VINTAGE,
    geographies: resolved,
    geocode: geocode ?? null,
    shortage: shortage ?? null,
    hud: hud ?? null,
  };
}
