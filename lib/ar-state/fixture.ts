// The AR state grant repository — the one-time reviewed seed fixture (40 programs) + shared types.
//
// This is a CURATED, HUMAN-REVIEWED list (Shannon, 2026-09), NOT a live data source. It was distilled
// once from a throwaway spreadsheet: 552 rows -> the AR-anchored state/local slice -> deduped ->
// federal / philanthropy / other-states dropped -> 40. After the one-time seed it is only a code
// record of what was seeded; the repository grows via the admin console + (later) Score-a-grant, both
// of which reuse the SAME addSource path. Config-as-code with a diff + blame line — the sources.ts /
// extraction-prompt discipline.
//
// Every field the platform actually keeps (status, deadlines, awards, eligibility) is RE-DERIVED from
// the live page at seed and refreshed by the weekly monitor — the sheet's year-old values are never
// treated as truth. So the fixture carries only the durable identity: who, what, where to watch, and
// (for the programs that SHARE a landing page with a sibling) a one-line seed_text so the shred can
// tell them apart.

export type Jurisdiction = "AR"; // first-class state key; 'MS'/'OK'... later = pure data, no schema change
export type FunderType = "state" | "local" | "private"; // 'private' reserved for the later philanthropy build
export type MonitorMode = "auto" | "reference"; // 'auto' = scan the page; 'reference' = no page to diff (future)

// Informational tags surfaced in the dry-run; behaviour is derived from code, never from a tag:
//   headless   -> a JS-rendered page (needsHeadless derives this from the domain, independently)
//   pass_through-> federal $ state-administered (SGG doesn't surface the client-actionable sub-award)
//   shared_page -> shares monitor_url with a sibling; carries seed_text so the shred disambiguates
//   repointed   -> url moved off a non-authoritative source to the agency's own page
//   verify_url  -> the seeded url needs a live reachability check in the dry-run before it goes in
export type SeedTag = "headless" | "pass_through" | "shared_page" | "repointed" | "verify_url";

export interface SeedGrant {
  grantor: string;
  program: string;
  url: string;
  jurisdiction: Jurisdiction;
  funder_type: FunderType;
  monitor_mode: MonitorMode;
  seed_text?: string; // per-program disambiguation (shared_page + repointed entries)
  tags?: SeedTag[];
}

// Provenance stamp written to grant_monitor_state.seed_batch, so every row this fixture created is
// queryable as one cohort (and a re-seed is a no-op via the source_url dedup, never a duplicate).
export const SEED_BATCH = "ar_master_sheet_2026";

// Domains whose opportunity content is injected client-side, so a plain server-HTML GET reads an empty
// shell — they must be rendered in headless Chromium first (the #531 finding: AEDC + DFA). Derived
// from the domain rather than a stored column so a console-added source on the same domain is handled
// automatically and no migration is needed to flip one. Matches on the registrable host suffix.
const HEADLESS_DOMAINS = ["arkansasedc.com", "dfa.arkansas.gov"] as const;

export function needsHeadless(url: string): boolean {
  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return false;
  }
  return HEADLESS_DOMAINS.some((d) => host === d || host.endsWith(`.${d}`));
}

// A "d" helper only to keep the array literal below terse and scannable (all 40 are AR / state / auto).
function ar(
  grantor: string,
  program: string,
  url: string,
  extra?: { seed_text?: string; tags?: SeedTag[] },
): SeedGrant {
  return {
    grantor,
    program,
    url,
    jurisdiction: "AR",
    funder_type: "state",
    monitor_mode: "auto",
    ...extra,
  };
}

export const AR_STATE_SEED: SeedGrant[] = [
  // ── AR Economic Development Commission (arkansasedc.com — headless) ──
  ar("AR Economic Development Commission", "Community Assistance Grant Program (CAGP)", "https://www.arkansasedc.com/community-resources/community-assistance-grant-program", { tags: ["headless"] }),
  ar("AR Economic Development Commission", "Community Development Block Grant / Small Cities (ACEDP)", "https://www.arkansasedc.com/community-resources/community-development-block-grant", { tags: ["headless", "pass_through"] }),
  ar("AR Economic Development Commission", "Rural Community Grant Program (RCGP)", "https://www.arkansasedc.com/Rural-Services/division/grants/rural-community-grant", { tags: ["headless"] }),
  ar("AR Economic Development Commission", "Rural Services Block Grant", "https://www.arkansasedc.com/Rural-Services/division/grants/rural-services-block-grant", { tags: ["headless"] }),
  ar("AR Economic Development Commission", "Site Development Program", "https://www.arkansasedc.com/community-resources/arkansas-site-development-program", { tags: ["headless"] }),
  ar("AR Economic Development Commission", "Business & Technology Accelerator Grant", "https://www.arkansasedc.com/science-technology/division/commercialization/business-technology-accelerator-grant", { tags: ["headless"] }),

  // ── AR Dept. of Finance & Administration — JAG (dfa.arkansas.gov — headless) ──
  ar("AR Dept. of Finance & Administration", "JAG – Local Law Enforcement (jurisdictions under 10k)", "https://www.dfa.arkansas.gov/office/intergovernmental-services/grant-programs/justice-assistance-grants-jag-local-law-enforcement-grant-program/", { tags: ["headless", "pass_through"] }),

  // ── AR Dept. of Transportation (ardot.gov) ──
  ar("AR Dept. of Transportation", "Economic Development Funding", "https://ardot.gov/divisions/local-programs/local-funding-opportunities/economic-development-funding/"),
  ar("AR Dept. of Transportation", "Intersection Improvement Program (IIP)", "https://ardot.gov/divisions/local-programs/local-funding-opportunities/iip/"),
  ar("AR Dept. of Transportation", "Recreational Trails Program (RTP)", "https://ardot.gov/divisions/local-programs/local-funding-opportunities/recreational-trails-program/", { tags: ["pass_through"] }),
  ar("AR Dept. of Transportation", "Transportation Research & Workforce Development Grants", "https://ardot.gov/divisions/planning/research/trrgp/"),
  ar("AR State Aid Street Committee", "State Aid City Street Program", "https://citystreet.arkansas.gov/"),

  // ── AR Department of Agriculture (agriculture.arkansas.gov) ──
  ar("AR Department of Agriculture", "Unpaved Roads Program (AURP)", "https://agriculture.arkansas.gov/natural-resources/divisions/water-management/arkansas-unpaved-roads-program/"),
  ar("AR Department of Agriculture", "Conservation District Grants", "https://agriculture.arkansas.gov/natural-resources/conservation/conservation-district-support/"),
  ar("AR Department of Agriculture – Forestry", "Firewise USA Grants", "https://agriculture.arkansas.gov/forestry/arkansas-firewise/"),
  ar("AR Department of Agriculture", "Specialty Crop Block Grant Program (SCBGP)", "https://agriculture.arkansas.gov/resources/grants/", { tags: ["pass_through"] }),
  ar("AR Department of Agriculture – Forestry", "Wildland Fire Suppression Kits / VFA Support", "https://agriculture.arkansas.gov/forestry/", {
    tags: ["verify_url"],
    seed_text:
      "AR Dept. of Agriculture Forestry Division — in-kind wildland fire suppression equipment packages for rural volunteer fire departments (VFA support). NOTE: the seeded URL is the Forestry Division section; confirm the live program page before relying on the auto-derived detail.",
  }),

  // ── AR Dept. of Parks, Heritage & Tourism (adpht.arkansas.gov) ──
  ar("AR Dept. of Parks, Heritage & Tourism", "FUN Park Grants", "https://adpht.arkansas.gov/office-of-outdoor-recreation/arkansas-outdoor-grants/fun-park-grants/"),
  ar("AR Dept. of Parks, Heritage & Tourism", "Matching Grants – Outdoor Recreation", "https://adpht.arkansas.gov/office-of-outdoor-recreation/arkansas-outdoor-grants/matching-grants/"),

  // ── Arkansas Heritage — Arts Council (shared page: aac-grants) ──
  ar("Arkansas Arts Council", "General Operating Support (GOS)", "https://www.arkansasheritage.com/arkansas-art-council/about/aac-grants", {
    tags: ["shared_page"],
    seed_text: "Arkansas Arts Council General Operating Support — core operating support for established AR arts nonprofits (annual income >= $50,000).",
  }),
  ar("Arkansas Arts Council", "Arts on Tour Grant", "https://www.arkansasheritage.com/arkansas-art-council/about/aac-grants", {
    tags: ["shared_page"],
    seed_text: "Arkansas Arts Council Arts on Tour — reimburses AR nonprofits/schools/libraries for hiring a professional artist from the Arts on Tour Roster.",
  }),
  ar("Arkansas Arts Council", "Community Arts Project (CAP)", "https://www.arkansasheritage.com/arkansas-art-council/about/aac-grants", {
    tags: ["shared_page"],
    seed_text: "Arkansas Arts Council Community Arts Project — project grants ($1k–$10k) for public-facing community arts, especially in rural/underserved areas.",
  }),

  // ── Arkansas Heritage — Historic Preservation (shared page: available-grants) ──
  ar("AR Historic Preservation Program", "Certified Local Government (CLG) Grant", "https://www.arkansasheritage.com/arkansas-preservation/about/available-grants", {
    tags: ["shared_page", "pass_through"],
    seed_text: "AHPP Certified Local Government Grant — federal Historic Preservation Fund pass-through to AR cities/counties participating in the CLG program.",
  }),
  ar("AR Historic Preservation Program", "County Courthouse Restoration Grants", "https://www.arkansasheritage.com/arkansas-preservation/about/available-grants", {
    tags: ["shared_page"],
    seed_text: "AHPP County Courthouse Restoration — structural/accessibility rehab of National Register historic county courthouses owned by county governments.",
  }),
  ar("AR Historic Preservation Program", "Historic Preservation Restoration Grant", "https://www.arkansasheritage.com/arkansas-preservation/about/available-grants", {
    tags: ["shared_page"],
    seed_text: "AHPP Historic Preservation Restoration Grant — rehab of National Register-listed/eligible properties; nonprofits, local governments, and eligible owners.",
  }),

  // ── Arkansas Heritage — State Archives + Main Street ──
  ar("Arkansas State Archives", "Curtis H. Sykes Memorial Grant Program", "https://www.arkansasheritage.com/arkansas-state-archives/arkansas-state-archives-about/available-grants"),
  ar("Arkansas Heritage – Main Street", "Downtown Revitalization Grant", "https://www.arkansasheritage.com/mainstreet-arkansas/main-street-grants", {
    tags: ["shared_page"],
    seed_text: "Main Street Arkansas Downtown Revitalization Grant — design-related projects for certified Main Street Arkansas communities.",
  }),
  ar("Arkansas Heritage – Main Street", "Public Art Grant Program", "https://www.arkansasheritage.com/mainstreet-arkansas/main-street-grants", {
    tags: ["shared_page"],
    seed_text: "Main Street Arkansas Public Art Grant ($1k–$10k) — site-specific public art for Main Street and Arkansas Downtown Network communities.",
  }),

  // ── AR Dept. of Public Safety — fire (shared page: fire-services) ──
  ar("AR Dept. of Public Safety", "Community Fire Prevention Grant Program", "https://dps.arkansas.gov/emergency-management/adem/state-fire-marshals-office/fire-services/", {
    tags: ["shared_page"],
    seed_text: "AR DPS Community Fire Prevention Grant ($20k–$30k) — fire prevention, outreach, and education for fire departments and community/faith-based groups.",
  }),
  ar("AR Dept. of Public Safety", "Act 833 Fire Protection Grant", "https://dps.arkansas.gov/emergency-management/adem/state-fire-marshals-office/fire-services/", {
    tags: ["shared_page", "repointed"],
    seed_text:
      "AR DPS Act 833 Fire Protection Grant ($10k–$50k) — insurance-premium-tax funding to certified AR fire departments for facilities and NFPA-compliant equipment. (Re-pointed from the firegrantshelp.com aggregator to the DPS source.)",
  }),

  // ── Other AR agencies ──
  ar("AR Development Finance Authority", "Emergency Solutions Grants (ESG)", "https://adfa.arkansas.gov/programs/emergency-solutions-grant-program/", { tags: ["pass_through"] }),
  ar("Arkansas 911 Board", "PSAP Maintenance Reimbursements & Support", "https://911board.arkansas.gov/about/"),
  ar("AR Office of Skills Development", "Workforce Training Grants", "https://arkansasosd.com/grantresources/"),
  ar("Engage Arkansas", "AmeriCorps State Formula (Planning/Operating)", "https://engagearkansas.org/funding-opportunities/", { tags: ["pass_through"] }),
  ar("AR Minority Health Commission", "Mini-Grants", "https://healthy.arkansas.gov/boards-commissions/commissions/arkansas-minority-health-commission/"),
  ar("AR Department of Health", "Rural Health Grant Programs", "https://healthy.arkansas.gov/programs-services/prevention-healthy-living/rural-health-primary-care/"),
  ar("AR Division of Aeronautics", "State Airport Aid Program", "https://fly.arkansas.gov/"),
  ar("AR Waterways Commission", "Port, Intermodal & Waterway Development Grant", "https://waterways.arkansas.gov/grant-program/"),
  ar("Arkansas Opioid Recovery Partnership", "General Settlement Application", "https://www.arorp.org/learn-more-general-application/"),
  ar("Arkansas Opioid Recovery Partnership", "Naloxone Community Hero Project", "https://www.arorp.org/funding-opportunities/"),
];
