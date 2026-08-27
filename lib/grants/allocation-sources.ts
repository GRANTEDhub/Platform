// CFDA / assistance-listing → authoritative .gov source URLs, handed to the IntellEngine QA
// reviewer so it FETCHES the real allocation / eligibility page instead of guessing a URL.
//
// WHY A SEED MAP AT ALL. fetchGrantSource is fetch-only, not search — it can GET a URL it is
// given (and follow .gov links inside a fetched page), but it cannot DISCOVER a page. For
// formula / allocation programs the eligibility reality lives on a SEPARATE agency page the
// NOFO may not link (the canonical case: a unit of local government that is an "asterisk" /
// disparate jurisdiction on the Byrne-JAG local allocation list and structurally cannot file a
// direct application, even though the NOFO's entity-type list reads "units of local government").
// So we hand the reviewer the known authoritative page(s) for that program family; the reviewer
// still fetches and reads them itself, and a wrong/dead URL simply comes back as a typed
// "could not retrieve" → the verdict fails SAFE to "unverified", never a guess.
//
// DATA, NOT LOGIC. Grows one entry at a time as we learn which programs have an allocation
// reality the NOFO understates. Keyed on the assistance-listing (CFDA) number captured on the
// grant (grants.assistance_listings), which is the reliable formula signal (program_type has no
// formula bucket). Everything here is a .gov URL (the fetch allowlist enforces that anyway).

export interface AllocationSource {
  label: string;
  // Authoritative .gov page(s) for this program's allocation / applicant-eligibility reality.
  // Prefer a stable program/allocations landing page; the reviewer can follow a link from it to
  // the current-year table. Order = suggested fetch order.
  urls: string[];
}

// JAG allocations URL — VERIFIED live (2026-08-27): the FY26 Arkansas Local JAG allocations PDF
// returns 200 application/pdf and pdf-parse extracts it cleanly (2 pages, names Mississippi County,
// the shaded disparate groups, the single-fiscal-agent / one-award / MOU rule). The earlier best-effort
// year-less guess (…/jag-local-allocations-ar.pdf) only 301-redirects to the FY25 file, so the QA pass
// couldn't reliably ground on it. YEAR-STAMPED URL — this is fy26; it must be bumped to fy27 when BJA
// posts the next cycle (a one-line data change). Kept AR-specific because the disparate-jurisdiction
// table is per-state and GRANTED's roster is Arkansas-anchored; other states need their own entry.
export const ALLOCATION_SOURCES: Record<string, AllocationSource> = {
  // Edward Byrne Memorial Justice Assistance Grant (JAG) — Local. The local allocation table
  // marks disparate / asterisk jurisdictions that must apply jointly / through the county / via
  // the state, i.e. cannot prime a direct application despite being a "unit of local government".
  "16.738": {
    label: "Edward Byrne Memorial Justice Assistance Grant (JAG) — FY26 Arkansas Local allocations & disparate/asterisk jurisdictions",
    urls: [
      "https://bja.ojp.gov/funding/fy26-jag-local-allocations-ar.pdf",
      "https://bja.ojp.gov/program/jag/overview",
    ],
  },
};

// Normalize an assistance-listing number to the map key: strip a trailing letter suffix some
// sources add (e.g. "16.738A" → "16.738") and surrounding whitespace. Non-CFDA-shaped strings
// pass through trimmed and simply won't match.
function normalizeCfda(raw: string): string {
  return raw.trim().replace(/[A-Za-z]$/, "");
}

// The authoritative sources for a grant, de-duplicated across its assistance listings. Empty when
// none of the grant's CFDA numbers are seeded — which is the common case, and fine: the reviewer
// then verifies against the NOFO's own source_url and any .gov links it carries.
export function allocationSourcesFor(
  assistanceListings: { number?: string | null }[] | null | undefined,
): AllocationSource[] {
  const out: AllocationSource[] = [];
  const seen = new Set<string>();
  for (const a of assistanceListings ?? []) {
    const num = a?.number ? normalizeCfda(a.number) : "";
    if (!num || seen.has(num)) continue;
    seen.add(num);
    const src = ALLOCATION_SOURCES[num];
    if (src) out.push(src);
  }
  return out;
}
