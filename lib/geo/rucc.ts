// USDA ERS 2023 Rural-Urban Continuum Codes (RUCC), county-level lookup.
//
// Source: USDA Economic Research Service, "Rural-Urban Continuum Codes" 2023
// edition (last updated 2024-01-22), https://www.ers.usda.gov/data-products/rural-urban-continuum-codes
// The published CSV (FIPS, State, County_Name, RUCC_2023, ...) is pivoted into
// lib/geo/data/rucc-2023.json — a state -> normalized-county -> { rucc, fips } map.
// 3,233 counties across 56 states/territories. There is NO live USDA API; this is
// the authoritative crosswalk, refreshed only when USDA publishes a new edition.
//
// ENRICHMENT / CITATION ONLY: used to auto-derive a client's rurality from their
// county as a sourced data point. Post-#241 the matcher treats RUCC as a flag, never
// a gate, so this can never hide a grant.

import RUCC_COUNTIES from "./data/rucc-2023.json";

// The nine official 2023 code descriptions, copied verbatim from the USDA file's
// Description column (not paraphrased).
export const RUCC_2023_DESCRIPTIONS: Record<number, string> = {
  1: "Metro - Counties in metro areas of 1 million population or more",
  2: "Metro - Counties in metro areas of 250,000 to 1 million population",
  3: "Metro - Counties in metro areas of fewer than 250,000 population",
  4: "Nonmetro - Urban population of 20,000 or more, adjacent to a metro area",
  5: "Nonmetro - Urban population of 20,000 or more, not adjacent to a metro area",
  6: "Nonmetro - Urban population of 5,000 to 20,000, adjacent to a metro area",
  7: "Nonmetro - Urban population of 5,000 to 20,000, not adjacent to a metro area",
  8: "Nonmetro - Urban population of fewer than 5,000, adjacent to a metro area",
  9: "Nonmetro - Urban population of fewer than 5,000, not adjacent to a metro area",
};

// Short label for a compact citation. 1-3 metro, 4-9 nonmetro.
export function ruccShortLabel(rucc: number): string {
  if (rucc >= 1 && rucc <= 3) return "Metro";
  if (rucc >= 4 && rucc <= 9) return "Nonmetro";
  return "Unknown";
}

type CountyMap = Record<string, Record<string, { rucc: number; fips: string }>>;
const COUNTIES = RUCC_COUNTIES as CountyMap;

// MUST stay byte-identical to the normalization used to build rucc-2023.json
// (scripts that regenerate the asset use the same rule), so a client's typed county
// resolves. lowercase, drop a trailing period, strip a trailing entity-type suffix,
// collapse whitespace.
export function normalizeCountyName(county: string): string {
  return county
    .toLowerCase()
    .trim()
    .replace(/\.$/, "")
    .replace(/\s+(county|parish|borough|census area|municipality|city and borough|co)$/, "")
    .replace(/\s+/g, " ")
    .trim();
}

export interface RuccResult {
  rucc: number;
  fips: string;
  description: string;
  label: string; // "Metro" | "Nonmetro"
}

// Resolve RUCC from a client's state (2-letter) + county name. Returns null when the
// state/county is missing or doesn't resolve (defensive: the caller no-ops on null).
export function ruccForCountyState(
  state: string | null | undefined,
  county: string | null | undefined,
): RuccResult | null {
  const st = (state ?? "").trim().toUpperCase();
  const co = (county ?? "").trim();
  if (!st || !co) return null;
  const hit = COUNTIES[st]?.[normalizeCountyName(co)];
  if (!hit) return null;
  return {
    rucc: hit.rucc,
    fips: hit.fips,
    description: RUCC_2023_DESCRIPTIONS[hit.rucc] ?? "",
    label: ruccShortLabel(hit.rucc),
  };
}

// Human/citation string stored into clients.rucc_codes when auto-derived. Self-
// documenting so its provenance survives a later manual edit.
export function formatRuccForStorage(county: string, r: RuccResult): string {
  return `${r.rucc} (${r.label}) — auto-derived from ${county.trim()} (USDA ERS 2023)`;
}
