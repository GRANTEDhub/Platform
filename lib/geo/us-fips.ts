// U.S. state -> 2-digit FIPS code. Shared geographic primitive for Census-backed
// lookups. directories.ts carries its own copy (the shipped prospecting path); new
// geo code uses this one so a future task can dedupe onto it without touching that file.

export const STATE_FIPS: Record<string, string> = {
  AL: "01", AK: "02", AZ: "04", AR: "05", CA: "06", CO: "08", CT: "09", DE: "10",
  DC: "11", FL: "12", GA: "13", HI: "15", ID: "16", IL: "17", IN: "18", IA: "19",
  KS: "20", KY: "21", LA: "22", ME: "23", MD: "24", MA: "25", MI: "26", MN: "27",
  MS: "28", MO: "29", MT: "30", NE: "31", NV: "32", NH: "33", NJ: "34", NM: "35",
  NY: "36", NC: "37", ND: "38", OH: "39", OK: "40", OR: "41", PA: "42", RI: "44",
  SC: "45", SD: "46", TN: "47", TX: "48", UT: "49", VT: "50", VA: "51", WA: "53",
  WV: "54", WI: "55", WY: "56",
};

// Normalize a 2-letter state to its FIPS, or null if unknown. Accepts lower/mixed case.
export function stateFips(state: string | null | undefined): string | null {
  if (!state) return null;
  return STATE_FIPS[state.trim().toUpperCase()] ?? null;
}
