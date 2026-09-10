// The Arkansas state/regional funding scraper — source registry (types + the 9-source seed).
//
// This scraper is a SEPARATE, additive monitor that never touches grants.gov / Simpler.gov. It
// watches a fixed set of AR state-agency and regional pages, detects new opportunities and deadline
// changes, and hands GRANT-type hits into the EXISTING shred+match pipeline. It reuses the pipeline
// wholesale — it never re-implements matching, and it edits NONE of the six protected files
// (engine.ts, pipeline.ts, match-queue.ts, queue.ts, gate.ts, cron/ingest/route.ts).
//
// ── WHY THE SOURCE DEFINITIONS LIVE IN CODE ──
//
// The `ar_grant_sources` table (migration 0094) holds per-source RUNTIME state — last_hash,
// last_checked, last_changed. The source DEFINITIONS (which URLs, what agency, what geo/elig/funding
// tags) live HERE, in code, versioned and reviewable, and are upserted into the table on every run
// (ensureSources). That is the same discipline as the extraction prompt and the GrantBot
// instructions: config that governs client-facing behaviour is code with a diff and a blame line,
// not a hand-edited row.
//
// ── THE TWO ENFORCED TAGS + THE FUNDING-TYPE TAG ──
//
// geo_tag + elig_tag are the source-level defaults for "who can apply / where". At promotion they
// are written into the grant's eligibility fields (via an authoritative preamble seeded into the
// shred input — see promote.ts) so the EXISTING matcher gates them the same way it gates every other
// grant. funding_type gates at the PROMOTION seam: a 'loan' item is recorded but NEVER promoted into
// `grants`, so a revolving/SRF loan can never surface as a grant (decision A — no in-matcher gate,
// no protected edit).

export type FundingType = "grant" | "loan" | "mixed";
export type FetchMode = "html" | "rss";

// A hit's resolved document class. Only `opportunity` (grant-type) is ever promoted into `grants`.
export type DocType = "opportunity" | "loan" | "pdf";

// ar_source_items.status — TEXT labels, never a colour (the colour-blind rule): a staffer reading
// the admin surface sees the word, not a hue.
//   new          a grant-type opportunity, freshly detected, promoted (or pending promotion)
//   promoted     promoted into `grants` (grant_id reachable via grants.ar_source_item_id)
//   skipped_loan a loan/financing product — recorded + traceable, deliberately NOT promoted
//   flagged_pdf  a NOFO/application PDF link — flagged (title + URL only, not parsed in v1)
//   changed      a previously-seen item whose salient fields (e.g. deadline) moved
export type ItemStatus = "new" | "promoted" | "skipped_loan" | "flagged_pdf" | "changed";

// Source cluster, for grouping in the admin surface only (not used by matching).
export type SourceCluster = "state_agency" | "regional_mpo" | "federal_regional";

// Source-level geography defaults. Each maps to a human eligibility sentence (GEO_TAG_DESCRIPTIONS)
// used to seed the grant's geographic_eligibility at promotion.
export type GeoTag = "AR-statewide" | "NWA-region" | "central-AR-region" | "delta-region";

// Source-level applicant-type defaults. Coarse by design for v1 (decision 1): a statewide agency
// serves many applicant types, so its tag is broad and the opportunity text refines it. Regional /
// single-purpose sources (NWA RPC, OSD) carry a tight tag that genuinely gates.
export type EligTag = "any" | "employer" | "local_gov" | "nonprofit" | "ihe";

// The code-side definition of a source. Runtime state (last_hash/last_checked/last_changed) is NOT
// here — it lives only in the table and is preserved across upserts.
export interface SourceSeed {
  url: string;
  agency: string;
  cluster: SourceCluster;
  geo_tag: GeoTag;
  elig_tag: EligTag;
  funding_type: FundingType;
  fetch_mode: FetchMode;
  rss_url?: string;
}

// The full row as stored (seed fields + runtime state + id).
export interface ArGrantSource extends SourceSeed {
  id: string;
  active: boolean;
  last_hash: string | null;
  last_checked: string | null;
  last_changed: string | null;
}

// ── THE 9 SOURCES ──
//
// URLS ARE v1 CONFIG. These are the best-known landing pages for each program family; the exact
// listing URL for some agencies may need one adjustment after the first admin dry-run reveals which
// pages return opportunity content vs. an empty shell (a JS-rendered page — see fetch.ts). Editing a
// URL is a one-line change here, re-upserted on the next run. This is deliberately data, kept
// reviewable in code.
export const AR_GRANT_SOURCES: SourceSeed[] = [
  {
    agency: "AEDC",
    url: "https://www.arkansasedc.com/programs-services",
    cluster: "state_agency",
    geo_tag: "AR-statewide",
    elig_tag: "any",
    funding_type: "mixed", // AEDC runs grants AND incentives/financing; per-item keywords decide
    fetch_mode: "html",
  },
  {
    agency: "DFA",
    url: "https://www.dfa.arkansas.gov/",
    cluster: "state_agency",
    geo_tag: "AR-statewide",
    elig_tag: "any",
    funding_type: "mixed",
    fetch_mode: "html",
  },
  {
    agency: "ADHE",
    url: "https://adhe.edu/",
    cluster: "state_agency",
    geo_tag: "AR-statewide",
    elig_tag: "ihe",
    funding_type: "grant",
    fetch_mode: "html",
  },
  {
    agency: "OSD",
    // The real OSD site is arkansasosd.com (NOT commerce.arkansas.gov, which 404'd). This is the
    // Training Grants / grant-resources page for AR employers.
    url: "https://arkansasosd.com/grantresources-2/",
    cluster: "state_agency",
    geo_tag: "AR-statewide",
    elig_tag: "employer",
    funding_type: "grant",
    fetch_mode: "html",
  },
  {
    agency: "NWA RPC",
    // No RSS feed exists (the old /feed/ returned nothing). Their funding-programs page carries the
    // STBGP-A / TAP / CRP "Call for Projects" — an HTML listing page, so scrape HTML, not RSS.
    url: "https://www.nwarpc.org/funding-programs/",
    cluster: "regional_mpo",
    geo_tag: "NWA-region",
    elig_tag: "local_gov",
    funding_type: "grant",
    fetch_mode: "html",
  },
  {
    agency: "Metroplan",
    url: "https://metroplan.org/",
    cluster: "regional_mpo",
    geo_tag: "central-AR-region",
    elig_tag: "local_gov",
    funding_type: "grant",
    fetch_mode: "html",
  },
  {
    agency: "DRA",
    // Funding-programs listing (SEDAP / CIF / Delta Workforce / WORC …). Old /funding/ 404'd.
    url: "https://dra.gov/programs/",
    cluster: "federal_regional",
    geo_tag: "delta-region",
    elig_tag: "any",
    funding_type: "grant",
    fetch_mode: "html",
  },
  {
    agency: "ADPHT Outdoor Rec",
    // The grants admin lives on adpht.arkansas.gov (a .gov), NOT arkansasstateparks.com (the parks
    // site, which 404'd on /about/grants). This is the Office of Outdoor Recreation grants hub
    // (FUN Park / Matching / Great Strides, with application windows + deadlines).
    url: "https://adpht.arkansas.gov/office-of-outdoor-recreation/arkansas-outdoor-grants/",
    cluster: "state_agency",
    geo_tag: "AR-statewide",
    elig_tag: "local_gov",
    funding_type: "grant",
    fetch_mode: "html",
  },
  {
    agency: "AR Ag NRD",
    url: "https://agriculture.arkansas.gov/natural-resources/water-development/water-and-wastewater-funding/",
    cluster: "state_agency",
    geo_tag: "AR-statewide",
    elig_tag: "local_gov",
    // Mostly subsidized SRF/bond LOANS (CWSRF, DWSRF, WDF, WSSW, CGO) — those are skipped_loan.
    // The forthcoming Water & Sewer Treatment Facility Grant Program is the grant to catch here.
    funding_type: "mixed",
    fetch_mode: "html",
  },
];

// ── TAG → HUMAN ELIGIBILITY SENTENCES ──
//
// These feed the authoritative eligibility preamble seeded into the shred input at promotion
// (promote.ts). The matcher's LLM geography/entity gates then read the grant's geographic_eligibility
// and eligible_entity_types the shredder extracts from that preamble — so a Faulkner County client is
// gated off an NWA-region call, and a nonprofit off an employer-only OSD call, by the SAME machinery
// that gates every other grant (decision B).
export const GEO_TAG_DESCRIPTIONS: Record<GeoTag, string> = {
  "AR-statewide":
    "the State of Arkansas (statewide). Applicants must be located in or primarily serve Arkansas.",
  "NWA-region":
    "the Northwest Arkansas region — Benton, Washington, Madison, and Carroll counties, Arkansas. Applicants must be located in or serve that region; organizations outside Northwest Arkansas are not eligible.",
  "central-AR-region":
    "the Central Arkansas / Metroplan region — Pulaski, Faulkner, Saline, Lonoke, and adjoining counties, Arkansas. Applicants must be located in or serve that region; organizations outside Central Arkansas are not eligible.",
  "delta-region":
    "the Delta Regional Authority service area — eligible Arkansas Delta counties. Applicants must be located in an eligible Delta county.",
};

export const ELIG_TAG_DESCRIPTIONS: Record<EligTag, string> = {
  any: "This source funds a range of applicant types; rely on the opportunity text below for the specific applicant eligibility.",
  employer:
    "employers and businesses (and, where the opportunity states, their training partners). Nonprofits and individuals applying on their own behalf are generally not eligible.",
  local_gov:
    "units of local government — municipalities and counties — and, where the opportunity states, regional planning organizations and public utilities. Private applicants are generally not eligible.",
  nonprofit:
    "nonprofit organizations (and, where the opportunity states, units of local government). For-profit entities are generally not eligible.",
  ihe: "institutions of higher education. Other applicant types are generally not eligible.",
};
