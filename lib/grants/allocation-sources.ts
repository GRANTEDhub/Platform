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
  // the current-year table. Order = suggested fetch order. This is the DEFAULT / local-side variant.
  urls: string[];
  // OPTIONAL STATE-side variant, for a formula program (Byrne-JAG 16.738) whose applicant reality is
  // OPPOSITE by entity type: the LOCAL solicitation's disparate/'asterisk' table (in `urls`) is the wrong
  // evidence for a STATE (State Administering Agency) client — the state never appears on a local table, so
  // handing it that page makes the reviewer mis-infer "absent → subrecipient" and over-demote a genuine
  // direct recipient (the 2026-09-03 unsafe-direction finding). When the client is `state_government`,
  // `allocationSourcesFor` returns `stateUrls`/`stateLabel` instead — pages that NAME the state as the
  // direct recipient. Absent → the client gets `urls` (byte-identical to before).
  stateUrls?: string[];
  stateLabel?: string;
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
    // STATE side. Byrne-JAG covers BOTH the State and Local solicitations under ONE CFDA (16.738), but the
    // applicant reality is opposite: a state_government client is the Governor-designated State Administering
    // Agency — the DIRECT recipient of the State allocation — not a subgrantee. It must read the STATE
    // allocations page + the SAA directory, NOT the local disparate-jurisdiction table above. Both VERIFIED
    // LIVE 2026-09-03: the JAG allocations page shows "FY 2026 JAG State Allocations" (a stable program
    // landing page that links the current-year state table, so it does not FY-rot like the local PDF), and
    // the OJP SAA overview states OJP formula grants "are awarded directly to state governments." Both .gov.
    stateLabel:
      "Edward Byrne Memorial Justice Assistance Grant (JAG) — State allocations; the Governor-designated State Administering Agency is the DIRECT recipient (not a subgrantee)",
    stateUrls: [
      "https://bja.ojp.gov/program/jag/allocations",
      "https://www.ojp.gov/funding/state-administering-agencies/overview",
    ],
  },
  // Crime Victim Assistance (VOCA — Victim Assistance Formula). A formula grant to the STATES; the
  // eligibility reality the NOFO's entity-type list understates is that local / nonprofit
  // victim-services providers are SUBGRANTEES through the state VOCA administering agency, never
  // direct federal applicants. Unlike JAG, this is a STRUCTURAL nationwide rule (no per-state
  // allocation table to ground on), and the OVC formula-grants page STATES THE RULE ON THE LANDING
  // PAGE ITSELF ("applications … may be submitted online only by the state agency designated by the
  // Governor"; "the states provide subgrants to local community-based organizations"), so one
  // national OVC page carries it — the grounding fact is on the fetched page, not a linked sub-page,
  // so it grounds more reliably than JAG's table-in-a-PDF. VERIFIED live (2026-08-28): 200, and the
  // subgrantee/administering-agency language is present in the page body. NOT year-stamped (a
  // structural program page, not a cycle-specific table), so it does not rot the way JAG's FY-stamped
  // allocations PDF does.
  "16.575": {
    label: "Crime Victim Assistance (VOCA Victim Assistance Formula) — states are the administering agencies; local/nonprofit providers are subgrantees through the state",
    urls: [
      "https://ovc.ojp.gov/funding/types-of-funding/formula-grants",
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
//
// `orgType` (the client's org_type) selects the state-vs-local variant ONLY for a program that has one
// (Byrne-JAG 16.738): a `state_government` client is the direct State Administering Agency and gets the
// STATE pages; every other org_type — and a caller that omits orgType entirely — gets the default `urls`,
// so all existing callers are byte-identical. Each returned entry is normalized to `{label, urls}` (the
// variant already resolved), which is all the QA context reads.
export function allocationSourcesFor(
  assistanceListings: { number?: string | null }[] | null | undefined,
  orgType?: string | null,
): AllocationSource[] {
  const out: AllocationSource[] = [];
  const seen = new Set<string>();
  const wantsState = orgType === "state_government";
  for (const a of assistanceListings ?? []) {
    const num = a?.number ? normalizeCfda(a.number) : "";
    if (!num || seen.has(num)) continue;
    seen.add(num);
    const src = ALLOCATION_SOURCES[num];
    if (!src) continue;
    if (wantsState && src.stateUrls && src.stateUrls.length > 0) {
      out.push({ label: src.stateLabel ?? src.label, urls: src.stateUrls });
    } else {
      out.push({ label: src.label, urls: src.urls });
    }
  }
  return out;
}
