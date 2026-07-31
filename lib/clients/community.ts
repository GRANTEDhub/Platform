import type { Client, ClientProfile, CommunityContext, ShortageDesignation } from "@/types/database";
import { ruccShortLabel } from "@/lib/geo/rucc";
import { samExpiryFlag } from "@/lib/sam/expiry";

// Pure view-model for the dashboard's community-context rail card. It reads the
// community_context already stored on clients.client_profile (built by
// lib/geo/census.ts + hrsa.ts at intake / refresh) -- it never fetches, so the
// dashboard stays a read.
//
// Its whole job is to keep three DIFFERENT kinds of "nothing" distinguishable,
// because collapsing them is how a rail card starts lying:
//
//   never checked      -- the lookup has not run for this client at all
//   checked, no data   -- it ran, and the source suppressed / did not resolve a value
//   checked, negative  -- it ran and the answer is genuinely "no" (a real finding)
//
// The last one matters most for shortage areas: HRSA's `designations: []` means the
// org's address was tested against the polygons and falls in none. That is a real
// negative worth showing, and rendering it as "unknown" would throw away a fact we
// paid an API call for. The type mirror documents the same distinction.

export type Availability = "value" | "none" | "unchecked";

export interface IncomeView {
  state: Availability;
  // Dollars, integer. Present only when state === "value".
  amount: number | null;
  // Whose income this is ("Pulaski County" / "Little Rock") -- a median with no
  // geography attached is not a fact, so this is required alongside the amount.
  geographyName: string | null;
  geographyLevel: "county" | "place" | null;
  sourceUrl: string | null;
}

export interface ShortageView {
  state: Availability;
  // Formatted one per line, strongest first. Empty when state !== "value".
  lines: string[];
}

export interface RuralityView {
  state: Availability;
  // "2 · metro" -- the USDA code and the band it falls in. The code alone is jargon and
  // the band alone loses the specificity a grant writer cites, so it is both.
  label: string | null;
  // The full stored string, including its provenance ("auto-derived from X (USDA ERS
  // 2023)"). Surfaced as a tooltip rather than inline: the card has room for the verdict,
  // not the citation, but the citation must not be unreachable.
  detail: string | null;
}

export interface SamView {
  state: Availability;
  label: string | null;
  // Whether this reads as a cleared requirement or an outstanding one. Drives the dot
  // colour, so it is decided here (where the expiry rules live) rather than in the card.
  ok: boolean;
}

export interface CommunityView {
  // Location label for the map tile. Null only when the client record carries no
  // location at all, in which case the caller drops the tile rather than captioning
  // a photo with nothing.
  placeLabel: string | null;
  income: IncomeView;
  shortage: ShortageView;
  rurality: RuralityView;
  // Submission readiness rather than geography, strictly speaking -- but the approved
  // design groups it into this card because the card answers "can this org receive this
  // money", and an unregistered SAM stops that as surely as failing an eligibility test.
  sam: SamView;
  // Provenance line: ACS vintage + which sources actually answered.
  vintage: string | null;
  checkedAt: string | null;
  // True when there is no community_context at all -- the caller renders a single
  // "not pulled yet" line instead of three separate unchecked rows, which would
  // triple one piece of information.
  unpulled: boolean;
}

// "Washington County, AR" -- county preferred over city because the shortage and
// income indicators are county/place-level community facts, and county is the
// geography federal eligibility language is usually written in. Falls back to city,
// then to the state alone.
export function placeLabelFor(client: Pick<Client, "location_county" | "location_city" | "location_state">): string | null {
  const state = client.location_state?.trim().toUpperCase() || null;
  const county = client.location_county?.trim() || null;
  const city = client.location_city?.trim() || null;
  const primary = county ? (/county|parish|borough/i.test(county) ? county : `${county} County`) : city;
  if (primary && state) return `${primary}, ${state}`;
  return primary || state;
}

// One designation as a compact line. The HPSA score is the competitiveness signal a
// grant writer actually cites, so it is kept; MUA/MUP carry a service-area name
// instead and no score.
function designationLine(d: ShortageDesignation): string {
  if (d.program === "HPSA") {
    const base = d.discipline ? `${d.discipline} HPSA` : "HPSA";
    return d.score != null ? `${base} · score ${d.score}` : base;
  }
  return d.name ? `${d.program} · ${d.name}` : d.program;
}

function buildIncome(cc: CommunityContext | null): IncomeView {
  const empty: IncomeView = { state: "unchecked", amount: null, geographyName: null, geographyLevel: null, sourceUrl: null };
  if (!cc) return empty;
  const geos = Array.isArray(cc.geographies) ? cc.geographies : [];
  // geographies is most-specific-first (place, then county). Take the most specific
  // one that actually HAS a median -- ACS suppresses small-geography values, so the
  // place can be blank while the county resolves.
  const hit = geos.find((g) => g.indicators?.median_household_income != null);
  if (hit) {
    return {
      state: "value",
      amount: hit.indicators.median_household_income,
      geographyName: hit.name,
      geographyLevel: hit.level,
      sourceUrl: hit.source_url ?? null,
    };
  }
  // The ACS pull ran (we have a context) but resolved no median: either no geography
  // matched by name, or ACS suppressed it. Either way it is "no data", not "unchecked".
  return { ...empty, state: geos.length > 0 ? "none" : "unchecked" };
}

function buildShortage(cc: CommunityContext | null): ShortageView {
  // shortage is null when the point lookup never ran -- which for HRSA means the
  // client has no resolvable STREET address, since the designation is point-in-polygon
  // on a geocoded tract. That is a fixable gap, so it must not read as "not in a
  // shortage area".
  if (!cc?.shortage) return { state: "unchecked", lines: [] };
  const designations = Array.isArray(cc.shortage.designations) ? cc.shortage.designations : [];
  if (designations.length === 0) return { state: "none", lines: [] };
  const lines = [...designations]
    // HPSA first (it carries a score), then by score desc so the strongest signal leads.
    .sort((a, b) => {
      if (a.program === "HPSA" && b.program !== "HPSA") return -1;
      if (b.program === "HPSA" && a.program !== "HPSA") return 1;
      return (b.score ?? -1) - (a.score ?? -1);
    })
    .map(designationLine);
  return { state: "value", lines };
}

// rucc_codes is a FREE-TEXT column. The refresh job writes
// "{code} ({label}) -- auto-derived from {county} (USDA ERS 2023)", but the intake form
// also lets a human type into it, so this parses defensively rather than assuming the
// machine format: a leading 1-9 is treated as the code and the band is re-derived from
// ruccShortLabel (never trusting a hand-typed band), and anything else non-empty is shown
// as-is instead of being discarded. A value we cannot parse is still a value someone
// entered on purpose.
function buildRurality(raw: string | null | undefined): RuralityView {
  const text = (raw ?? "").trim();
  if (!text) return { state: "unchecked", label: null, detail: null };
  const code = Number(text.match(/^\s*([1-9])\b/)?.[1]);
  if (Number.isFinite(code)) {
    return { state: "value", label: `${code} · ${ruccShortLabel(code).toLowerCase()}`, detail: text };
  }
  return { state: "value", label: text, detail: text };
}

// SAM readiness, reusing samExpiryFlag so the card cannot disagree with the expiry
// warnings shown elsewhere. Four outcomes, and the distinction that matters is between
// "nobody has bound a UEI yet" (a to-do) and "bound and lapsed" (a different, more urgent
// to-do) -- collapsing them into "unresolved" would hide which one you are looking at.
function buildSam(
  client: Pick<Client, "uei" | "sam_registration_status" | "sam_expiration_date">,
): SamView {
  const status = (client.sam_registration_status ?? "").trim();
  const uei = (client.uei ?? "").trim();
  const exp = (client.sam_expiration_date ?? "").trim();
  if (!uei && !status) return { state: "none", label: "Unresolved", ok: false };
  const flag = samExpiryFlag(exp || null);
  if (flag?.level === "expired") return { state: "value", label: "Expired", ok: false };
  if (flag) return { state: "value", label: flag.label, ok: false };
  return { state: "value", label: status || "Registered", ok: true };
}

export function buildCommunityView(
  client: Pick<
    Client,
    | "location_county"
    | "location_city"
    | "location_state"
    | "rucc_codes"
    | "uei"
    | "sam_registration_status"
    | "sam_expiration_date"
  > & {
    client_profile: ClientProfile | null;
  },
): CommunityView {
  const cc = client.client_profile?.community_context ?? null;
  return {
    placeLabel: placeLabelFor(client),
    income: buildIncome(cc),
    shortage: buildShortage(cc),
    rurality: buildRurality(client.rucc_codes),
    sam: buildSam(client),
    vintage: cc?.vintage ?? null,
    checkedAt: cc?.checked_at ?? null,
    unpulled: !cc,
  };
}

// Whole-dollar, no cents -- a median household income to the dollar implies a
// precision ACS does not publish.
export function formatIncome(amount: number): string {
  return `$${Math.round(amount).toLocaleString("en-US")}`;
}
