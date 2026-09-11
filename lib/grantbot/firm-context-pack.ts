// The FIRM roster pack: every active client's PROFILE, as structured cards plus one renderer over
// them. GrantBot Brick 1, the roster-wide sibling of context-pack.ts.
//
// ── PROFILES ONLY, BY CONSTRUCTION ──
//
// This module reads a NARROW slice of the clients row — identity, capability, and what the org
// SEEKS — and nothing per-client live: no cards, matches, alerts, drafts, documents, deadlines. That
// is the whole design (Shannon, 2026-09-11): the firm bot is a roster strategist over profiles; live
// grant/match activity stays in each client's own record and per-client GrantBot. Fanning the
// per-client pack's seven-table read across ~40 clients would be the "firehose" this deliberately
// avoids — the firm read is ONE query over ONE table (see firm-gather.ts).
//
// ── PURE ──
//
// No I/O, no server-only import. Rows in, pack + rendered roster out. firm-gather.ts does the reads,
// firm-prompt.ts assembles the blocks — the same split as context-pack.ts / gather.ts / prompt.ts, so
// the rules worth asserting (no commercial fields, provenance labels, aggregate gaps) are asserted
// offline against this module as compiled.

import type { Client, ClientProfile } from "@/types/database";

// The EXACT profile columns the firm pack renders. A Pick, so the select list in firm-gather.ts and
// the render here cannot drift, and so nothing commercial/billing (engagement_tier, retainer_hours,
// contract_*, stripe_*, seat_limit) or PII (primary_contact_*, location_street/zip) or
// eligibility-registry state (ein, uei, sam_*, usaspending_*, nonprofit_finance*) is ever selectable
// here — those are deliberately OUT of a profiles-only roster (a strategist, not an eligibility
// determiner). See firm-gather.ts FIRM_COLUMNS for the one-to-one match and the exclusion rationale.
export type FirmPackClient = Pick<
  Client,
  | "id" | "name" | "org_type" | "status"
  | "location_city" | "location_county" | "location_state" | "service_area"
  | "primary_funding_needs" | "project_stage" | "annual_budget" | "match_cost_share_capacity"
  | "client_profile" | "client_profile_generated_at"
  | "intake_data" | "profile_confirmed_at" | "updated_at"
>;

// The select list for the firm roster read, kept HERE (pure) rather than in the server-only gather so
// the "profiles only — nothing commercial/PII/eligibility" invariant is assertable offline. One-to-one
// with the FirmPackClient Pick above; firm-gather.ts imports it. Never `select *`.
export const FIRM_COLUMNS = [
  "id", "name", "org_type", "status",
  "location_city", "location_county", "location_state", "service_area",
  "primary_funding_needs", "project_stage", "annual_budget", "match_cost_share_capacity",
  "client_profile", "client_profile_generated_at",
  "intake_data", "profile_confirmed_at", "updated_at",
].join(", ");

// Columns that must NEVER appear in the firm roster read — commercial/billing, contact PII, and
// eligibility-registry state (deferred; the firm bot defers eligibility to the NOFO by design). The
// offline test asserts none of these is in FIRM_COLUMNS, so a future widening of the column list
// cannot silently pull a commercial or PII field into a profiles-only roster.
export const FIRM_FORBIDDEN_COLUMNS = [
  "engagement_tier", "retainer_hours", "contract_start", "contract_end", "contract_status",
  "contract_signed_at", "stripe_customer_id", "seat_limit",
  "primary_contact_name", "primary_contact_email", "primary_contact_phone",
  "location_street", "location_zip",
  "ein", "uei", "sam_registration_status", "sam_expiration_date", "sam_matched_name",
  "usaspending_summary", "usaspending_search_name", "nonprofit_finance",
  "notes", "next_step", "matching_rules", "hard_constraints", "known_constraints",
  "lead_source", "account_manager_id",
];

export interface FirmClientCard {
  id: string;
  name: string;
  orgType: string | null;
  status: string;
  location: string | null;
  serviceArea: string | null;
  // What they seek / capability (typed columns).
  fundingNeeds: string | null;
  projectStage: string | null;
  annualBudget: string | null;
  matchCapacity: string | null;
  // Distilled (machine-derived — may be wrong; the whole roster leans on this tier, so it is
  // labelled as such in the render).
  hasDistilledProfile: boolean;
  profileGeneratedAt: string | null;
  summary: string | null;
  mission: string | null;
  capabilities: string | null;
  programAreas: string | null;
  populations: string | null;
  geographicScope: string | null;
  primeCapacity: string | null;
  supportingRoles: string | null;
  fundingPriorities: string | null;
  partnerships: string | null;
  // Client-stated anchor (the org's OWN words — never rely solely on the least-trusted distilled
  // tier for identity; the MSET wrong-legal-name bug is a roster-wide risk).
  statedMission: string | null;
  statedFundingNeed: string | null;
  // Trust / staleness.
  profileConfirmedAt: string | null;
  rowTouchedAt: string;
}

export interface FirmContextPack {
  generatedAt: string;
  generatedBy: string;
  actorRole: string;
  clientCount: number;
  // org_type -> count, so the header can state portfolio shape without the bot counting cards.
  orgTypeBreakdown: Record<string, number>;
  cards: FirmClientCard[];
  // A closed predicate list of AGGREGATE absences (per-client gaps x 40 would be noise). Same
  // discipline as context-pack.ts buildGaps: every line is a fact about a specific absence.
  gaps: string[];
}

// ── SMALL HELPERS (mirrors context-pack.ts) ──

const clean = (v: unknown): string | null =>
  typeof v === "string" && v.trim() !== "" ? v.trim() : null;

const listOf = (v: unknown): string | null =>
  Array.isArray(v) && v.length
    ? v.filter((x) => typeof x === "string" && x.trim()).join(", ") || null
    : null;

// Date only, never a relative age — a system prompt is read later than it was assembled.
export function isoDate(v: string | null | undefined): string | null {
  if (!v) return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
}

function locationOf(c: FirmPackClient): string | null {
  return (
    [c.location_city, c.location_county ? `${c.location_county} County` : null, c.location_state]
      .filter(Boolean)
      .join(", ") || null
  );
}

function distilledFields(p: ClientProfile | null): Partial<FirmClientCard> {
  if (!p) return { hasDistilledProfile: false };
  const geo = p.geographic_scope;
  const geoStr = geo
    ? [geo.footprint, geo.scale ? `scale: ${geo.scale}` : null, listOf(geo.states) ? `states: ${listOf(geo.states)}` : null]
        .filter(Boolean)
        .join("; ") || null
    : null;
  const prime = p.prime_capacity;
  const primeStr = prime
    ? [
        `can prime: ${prime.can_prime ? "yes" : "no"}`,
        clean(prime.rationale),
        clean(prime.conditional_on) ? `conditional on: ${clean(prime.conditional_on)}` : null,
      ]
        .filter(Boolean)
        .join(" — ") || null
    : null;
  const programAreas = Array.isArray(p.program_areas)
    ? p.program_areas
        .map((a) => {
          const rec = a as unknown as Record<string, unknown>;
          const name = clean(rec.name) ?? clean(rec.area);
          const detail = clean(rec.description) ?? clean(rec.detail);
          return name ? `${name}${detail ? ` (${detail})` : ""}` : detail;
        })
        .filter(Boolean)
        .join("; ") || null
    : null;
  return {
    hasDistilledProfile: true,
    summary: clean(p.summary),
    mission: clean(p.mission),
    capabilities: listOf(p.core_capabilities),
    programAreas,
    populations: listOf(p.populations_served),
    geographicScope: geoStr,
    primeCapacity: primeStr,
    supportingRoles: listOf(p.supporting_roles),
    fundingPriorities: listOf(p.funding_priorities),
    partnerships: listOf(p.partnerships),
  };
}

function toCard(c: FirmPackClient): FirmClientCard {
  const intake = (c.intake_data ?? {}) as Record<string, unknown>;
  return {
    id: c.id,
    name: c.name,
    orgType: c.org_type,
    status: c.status,
    location: locationOf(c),
    serviceArea: listOf(c.service_area),
    fundingNeeds: listOf(c.primary_funding_needs),
    projectStage: c.project_stage,
    annualBudget: clean(c.annual_budget),
    matchCapacity: clean(c.match_cost_share_capacity),
    profileGeneratedAt: c.client_profile_generated_at ?? null,
    statedMission: clean(intake.mission),
    statedFundingNeed: clean(intake.funding_need),
    profileConfirmedAt: c.profile_confirmed_at ?? null,
    rowTouchedAt: c.updated_at,
    // distilled defaults, overwritten below
    hasDistilledProfile: false,
    summary: null,
    mission: null,
    capabilities: null,
    programAreas: null,
    populations: null,
    geographicScope: null,
    primeCapacity: null,
    supportingRoles: null,
    fundingPriorities: null,
    partnerships: null,
    ...distilledFields(c.client_profile),
  };
}

// ── AGGREGATE GAPS ──
//
// A CLOSED LIST OF PREDICATES over the roster, same design as context-pack.ts buildGaps: state a
// specific, checkable absence once, rather than inviting a section that "notes anything concerning".
export function buildFirmGaps(cards: FirmClientCard[]): string[] {
  const gaps: string[] = [];
  const total = cards.length;
  if (total === 0) {
    gaps.push("No active clients are in this roster.");
    return gaps;
  }
  const noProfile = cards.filter((c) => !c.hasDistilledProfile).length;
  const neverConfirmed = cards.filter((c) => !c.profileConfirmedAt).length;
  const noFundingSignal = cards.filter((c) => !c.fundingPriorities && !c.fundingNeeds && !c.statedFundingNeed).length;
  const noOrgType = cards.filter((c) => !c.orgType).length;
  const noStatedMission = cards.filter((c) => !c.statedMission && !c.mission).length;
  const undatedProfiles = cards.filter((c) => c.hasDistilledProfile && !c.profileGeneratedAt).length;

  if (noProfile > 0) {
    gaps.push(
      `${noProfile} of ${total} clients have NO distilled profile — for those, only their typed identity and stated intake are here, no machine-derived capability read.`,
    );
  }
  if (undatedProfiles > 0) {
    gaps.push(
      `${undatedProfiles} distilled profiles have NO generation date (they predate the column) — their age relative to the rest of the roster is unknown.`,
    );
  }
  if (neverConfirmed > 0) {
    gaps.push(
      `${neverConfirmed} of ${total} clients have NEVER confirmed their own profile — identity and contact details are as staff entered them.`,
    );
  }
  if (noStatedMission > 0) {
    gaps.push(`${noStatedMission} of ${total} clients have no mission statement in any form on file.`);
  }
  if (noFundingSignal > 0) {
    gaps.push(
      `${noFundingSignal} of ${total} clients carry no recorded funding priorities or needs — what they are seeking is unknown from this context.`,
    );
  }
  if (noOrgType > 0) {
    gaps.push(`${noOrgType} of ${total} clients have no org_type recorded — their entity-type eligibility cannot be reasoned from this context.`);
  }
  gaps.push(
    "This roster is PROFILES ONLY. It carries NO live grant activity for any client — no scored matches, grant cards, alerts, decisions, documents, or deadlines. Anything requiring that lives in the client's own record, not here.",
  );
  return gaps;
}

export interface FirmPackInput {
  generatedAt: string;
  generatedBy: string;
  actorRole: string;
  clients: FirmPackClient[];
}

export function buildFirmContextPack(input: FirmPackInput): FirmContextPack {
  const cards = input.clients.map(toCard);
  const orgTypeBreakdown: Record<string, number> = {};
  for (const c of cards) {
    const key = c.orgType ?? "(unrecorded)";
    orgTypeBreakdown[key] = (orgTypeBreakdown[key] ?? 0) + 1;
  }
  return {
    generatedAt: input.generatedAt,
    generatedBy: input.generatedBy,
    actorRole: input.actorRole,
    clientCount: cards.length,
    orgTypeBreakdown,
    cards,
    gaps: buildFirmGaps(cards),
  };
}

// ── THE RENDERER: ONE ROSTER BLOCK OVER THE CARDS ──
//
// Compact per client (target a few hundred words each, not the per-client pack's full detail), so a
// 40-client roster stays well inside the context window. Provenance is labelled inline: identity and
// typed fields are platform/client-stated; the distilled block is flagged MACHINE-DERIVED so the bot
// applies the precedence rule the guardrails state. Absences are the aggregate gaps at the end, once.
function renderCard(c: FirmClientCard, n: number): string {
  const lines: string[] = [];
  lines.push(`### ${n}. ${c.name}${c.orgType ? ` — ${c.orgType}` : ""}`);
  if (c.location) lines.push(`- Location: ${c.location}`);
  if (c.serviceArea) lines.push(`- Service area: ${c.serviceArea}`);
  // Client-stated anchor first (the org's own words), then the distilled read.
  if (c.statedMission) lines.push(`- Mission (client's own words): ${c.statedMission}`);
  if (c.statedFundingNeed) lines.push(`- What they say they need funded (client's own words): ${c.statedFundingNeed}`);
  if (c.hasDistilledProfile) {
    lines.push(
      `- DISTILLED PROFILE (machine-derived, may be wrong — trust it below typed and client-stated facts; generated ${
        isoDate(c.profileGeneratedAt) ?? "NO DATE RECORDED"
      }):`,
    );
    if (c.summary) lines.push(`  - Summary: ${c.summary}`);
    if (c.mission && c.mission !== c.statedMission) lines.push(`  - Mission (distilled): ${c.mission}`);
    if (c.capabilities) lines.push(`  - Core capabilities: ${c.capabilities}`);
    if (c.programAreas) lines.push(`  - Program areas: ${c.programAreas}`);
    if (c.populations) lines.push(`  - Populations served: ${c.populations}`);
    if (c.geographicScope) lines.push(`  - Geographic scope: ${c.geographicScope}`);
    if (c.primeCapacity) lines.push(`  - Prime capacity: ${c.primeCapacity}`);
    if (c.supportingRoles) lines.push(`  - Supporting roles it can genuinely fill: ${c.supportingRoles}`);
    if (c.partnerships) lines.push(`  - Partnerships: ${c.partnerships}`);
  }
  // What they seek / scale — typed columns (platform / client-stated).
  const priorities = c.fundingPriorities ?? c.fundingNeeds;
  if (priorities) lines.push(`- Funding priorities (what they want): ${priorities}`);
  if (c.fundingNeeds && c.fundingNeeds !== priorities) lines.push(`- Matcher priority areas: ${c.fundingNeeds}`);
  if (c.projectStage) lines.push(`- Project stage: ${c.projectStage}`);
  const scale = [c.annualBudget ? `annual budget ${c.annualBudget}` : null, c.matchCapacity ? `match capacity ${c.matchCapacity}` : null]
    .filter(Boolean)
    .join("; ");
  if (scale) lines.push(`- Scale (client-stated): ${scale}`);
  lines.push(
    `- [profile confirmed by the client: ${isoDate(c.profileConfirmedAt) ?? "NEVER"} · record last touched ${
      isoDate(c.rowTouchedAt) ?? "unknown"
    }]`,
  );
  return lines.join("\n");
}

export function renderFirmRoster(pack: FirmContextPack): string {
  const parts: string[] = [];
  parts.push("=".repeat(78));
  parts.push(`CLIENT ROSTER — GRANTED's ${pack.clientCount} active client(s)`);
  parts.push(
    `Assembled from the GRANTED platform on ${isoDate(pack.generatedAt) ?? "date unknown"}. Each entry is a PROFILE: who the org is, what it does, and what it is seeking. Every item carries its provenance; dates are absolute.`,
  );
  const breakdown = Object.entries(pack.orgTypeBreakdown)
    .sort((a, b) => b[1] - a[1])
    .map(([k, v]) => `${k}: ${v}`)
    .join(" · ");
  if (breakdown) parts.push(`Portfolio by org type: ${breakdown}.`);
  parts.push("");
  parts.push(
    "NOT IN THIS CONTEXT: any live grant activity — no scored matches, grant cards, alerts, decisions, documents, or deadlines for any client. Commercial/billing data and contact PII are excluded by design. When a question needs any of that, say so and point to the client's record or the official source.",
  );

  pack.cards.forEach((c, i) => {
    parts.push("");
    parts.push(renderCard(c, i + 1));
  });
  return parts.join("\n");
}

// The aggregate gaps as their own block (kept LAST in the prompt, like the per-client pack's gaps):
// the closed list of what the platform does not know is the instruction most easily overridden by a
// wall of what it does know, so recency helps it.
export function renderFirmGaps(pack: FirmContextPack): string {
  const parts: string[] = [
    "--- WHAT THE PLATFORM DOES NOT KNOW ABOUT THIS ROSTER ---",
    "(A fixed list of checks, not an assessment. Authoritative about absence: do not fill any of these from general knowledge.)",
  ];
  if (pack.gaps.length === 0) parts.push("- Every check passed.");
  else for (const g of pack.gaps) parts.push(`- ${g}`);
  return parts.join("\n");
}
