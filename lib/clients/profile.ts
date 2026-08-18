// Client refinement layer -- the symmetric half of grant Stage A.
//
// constructClientProfile distills an organization's intake (open-ended strategic
// free-text + structured fields + auto-pulled data) into a shape-validated
// ClientProfile: mission/programs/target-demographics-centered, with prime_capacity
// / supporting_roles / geographic scale carrying the prime-vs-partner distinction,
// and inferred[]/gaps[] for honesty. It DISTILLS -- it never fabricates capacity.
//
// Mirrors constructIdealApplicantProfile exactly: one temperature-0 forced
// tool-call, the tool input_schema IS the validation, and failure THROWS so the
// caller null-fallbacks (in Stage 1 the only caller is the preview route, which
// catches and reports). Stage 1 does NOT store the result and does NOT touch the
// matcher.

import type { SupabaseClient } from "@supabase/supabase-js";
import { getAnthropicClient, MODEL } from "@/lib/anthropic";
import { formatStoredUSASpending } from "@/lib/grants/usaspending";
import { formatStoredNonprofitFinance } from "@/lib/grants/propublica";
import { formatProgramsForDump, formatPartnersForDump } from "@/lib/intake/narrative";
import { buildCommunityContext } from "@/lib/geo/census";
import type { Client, ClientProfile } from "@/types/database";

// One input shape for everyone (lead / prospect / client) -- the lead/client flag
// is metadata, not input. buildClientProfileInput assembles this from a row.
export interface ClientProfileInput {
  orgName: string;
  strategicDump: string; // the open-ended free-text: mission, programs+demographics, partnerships, "anything else"
  structured: string; // org_type, geography, revenue, funding needs, match capacity, rurality, project stage
  autoPulled: string; // SAM entity (if bound) + USASpending (as CROSS-CHECK) + self-reported federal history
  documents?: string; // extracted text from uploads, when present (later stage)
}

const CLIENT_PROFILE_SYSTEM_PROMPT = `You are GRANTED's client-profile refiner. GRANTED is a U.S.-only grant consulting firm.
You are GIVEN one organization's intake -- an open-ended strategic dump plus some
structured and auto-pulled fields -- and you DISTILL it into a match-optimized
profile that the matching engine will later map against a grant's ideal-applicant
profile. You are the client-side mirror of the grant's ideal-applicant profile.

CORE DISCIPLINE:
1. DISTILL, never invent. Every claim must trace to the intake. If the intake does
   not support a field, leave it thin and record it in gaps -- do NOT fabricate
   capacity, programs, reach, or history to fill the shape.
2. Flag inference. Anything you inferred rather than were told explicitly goes in
   inferred[]. A confident-looking profile built on guesses is the worst output.
3. Mission, programs, and target demographics are the PRIORITY signal. Center the
   distillation there. Granular fiscal fields (budget, match capacity, rurality)
   are secondary -- fold them into fiscal_notes when present, never pad them.

PRIME VS PARTNER (never flatten this):
- prime_capacity.can_prime describes GENERAL capacity: can this org perform a core
  funded role AS ITS NATURAL FUNCTION, at a scale that could anchor an application?
  Default can_prime = FALSE. Set it true ONLY with genuine evidence in the intake.
  Eligibility or topical relatedness is NOT prime capacity. A regional org rarely
  primes a statewide program -- capture that in conditional_on and in the scale.
- supporting_roles = the supporting / co-applicant / partner seats the org can
  GENUINELY fill (name the real role, e.g. "behavioral-health integration partner",
  not generic "delivery partner"). A strong supporting fit is valuable; capture it.
- You are NOT assigning a seat. The matcher decides the per-grant seat later; you
  describe capacity. An org that can prime one program may only partner on another.

FEDERAL HISTORY:
- federal_history.self_reported is the organization's OWN answer and is
  AUTHORITATIVE. USASpending (in the auto-pulled block) is a fuzzy org-name match:
  use it only as usaspending_crosscheck, and if it clearly diverges from the
  self-report, note that in discrepancy -- do NOT let it override the self-report.

geographic_scope.scale must be one of: local, regional, statewide, multi_state,
national -- your honest read of the org's reach, not its ambition.

Write plainly. Do not use em dashes.`;

// Assemble the single input shape from a client row: strategic free-text, the
// structured fields, and the auto-pulled data (SAM if bound, USASpending as a
// cross-check, self-reported federal history).
export function buildClientProfileInput(client: Client): ClientProfileInput {
  const intake = (client.intake_data ?? {}) as Record<string, unknown>;
  const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : null);
  const list = (v: unknown) =>
    Array.isArray(v) ? v.filter((x) => typeof x === "string" && x.trim()).join(", ") : null;

  const dump = [
    ["Mission", str(intake.mission)],
    ["Programs", formatProgramsForDump(intake.programs)],
    ["What they're looking for", str(intake.funding_need)],
    ["Priority areas", list(intake.priority_areas) ?? list(client.primary_funding_needs)],
    // Structured partners when present; falls back to the legacy free-text field.
    ["Partnerships", formatPartnersForDump(intake.partners, intake.partnerships)],
    ["Additional context (client's words)", str(intake.additional_info)],
    ["Internal notes", str(client.notes)],
  ]
    .filter(([, v]) => v)
    .map(([k, v]) => `${k}: ${v}`)
    .join("\n");

  const structured = [
    ["Org type (self-declared)", str(client.org_type)],
    [
      "Location",
      [client.location_city, client.location_county, client.location_state].filter(Boolean).join(", ") || null,
    ],
    ["Service area", list(client.service_area)],
    ["RUCC / rurality", str(client.rucc_codes)],
    ["Annual budget", str(client.annual_budget)],
    ["Match / cost-share capacity", str(client.match_cost_share_capacity)],
    ["Primary funding needs", list(client.primary_funding_needs)],
    ["Project stage", str(client.project_stage)],
    ["Engagement tier", str(client.engagement_tier)],
  ]
    .filter(([, v]) => v)
    .map(([k, v]) => `${k}: ${v}`)
    .join("\n");

  const usa = client.federal_history_verified
    ? "Client-verified federal history is authoritative (below)."
    : formatStoredUSASpending(client.usaspending_summary) || "USASpending: not checked / no match.";
  const autoPulled = [
    ["Self-reported federal grant history (AUTHORITATIVE)", str(client.federal_grant_history) ?? "Not provided"],
    ["USASpending cross-check (fuzzy org-name match; supplement only)", usa],
    // Sourced budget citation from the org's latest IRS 990 (ProPublica), when an EIN
    // is on file. A supplement to the self-reported annual_budget, not an override.
    ["IRS 990 financials (ProPublica; sourced budget)", formatStoredNonprofitFinance(client.nonprofit_finance)],
    ["SAM registration", str(client.sam_registration_status) ?? str(client.sam_uei_status) ?? "Not verified"],
    ["SAM legal name", str(client.sam_matched_name)],
    ["UEI", str(client.uei)],
  ]
    .filter(([, v]) => v)
    .map(([k, v]) => `${k}: ${v}`)
    .join("\n");

  return {
    orgName: client.name,
    strategicDump: dump || "(no open-ended strategic text on file)",
    structured: structured || "(no structured profile fields on file)",
    autoPulled,
  };
}

function renderInput(input: ClientProfileInput): string {
  return [
    `ORGANIZATION: ${input.orgName}`,
    ``,
    `=== OPEN-ENDED STRATEGIC INTAKE (the priority signal -- distill mission, programs, demographics, partnerships from here) ===`,
    input.strategicDump,
    input.documents ? `\n=== UPLOADED DOCUMENTS (extracted text) ===\n${input.documents}` : ``,
    ``,
    `=== STRUCTURED FIELDS (secondary; fold in where present) ===`,
    input.structured,
    ``,
    `=== AUTO-PULLED / COMPLIANCE ===`,
    input.autoPulled,
  ]
    .filter(Boolean)
    .join("\n");
}

// The tool input_schema IS the shape validation (mirror of constructIdealApplicantProfile).
const CLIENT_PROFILE_TOOL = {
  name: "submit_client_profile",
  description:
    "Return the distilled, match-optimized client profile. Call this tool exactly once.",
  input_schema: {
    type: "object" as const,
    properties: {
      summary: { type: "string" },
      mission: { type: "string" },
      core_capabilities: { type: "array", items: { type: "string" } },
      program_areas: {
        type: "array",
        items: {
          type: "object",
          properties: {
            name: { type: "string" },
            status: { type: "string", enum: ["existing", "prospective"] },
            description: { type: "string" },
            target_demographics: { type: "array", items: { type: "string" } },
          },
          required: ["name", "status", "description", "target_demographics"],
        },
      },
      populations_served: { type: "array", items: { type: "string" } },
      geographic_scope: {
        type: "object",
        properties: {
          footprint: { type: "string" },
          scale: {
            type: "string",
            enum: ["local", "regional", "statewide", "multi_state", "national"],
          },
          states: { type: "array", items: { type: "string" } },
        },
        required: ["footprint", "scale", "states"],
      },
      prime_capacity: {
        type: "object",
        properties: {
          can_prime: { type: "boolean" },
          rationale: { type: "string" },
          conditional_on: { type: "string" },
        },
        required: ["can_prime", "rationale"],
      },
      supporting_roles: { type: "array", items: { type: "string" } },
      partnerships: { type: "array", items: { type: "string" } },
      funding_priorities: { type: "array", items: { type: "string" } },
      fiscal_notes: {
        type: "object",
        properties: {
          annual_budget: { type: "string" },
          match_capacity: { type: "string" },
          rurality: { type: "string" },
        },
      },
      federal_history: {
        type: "object",
        properties: {
          self_reported: { type: "string" },
          usaspending_crosscheck: { type: "string" },
          discrepancy: { type: "string" },
        },
        required: ["self_reported"],
      },
      inferred: { type: "array", items: { type: "string" } },
      gaps: { type: "array", items: { type: "string" } },
    },
    required: [
      "summary",
      "mission",
      "core_capabilities",
      "program_areas",
      "populations_served",
      "geographic_scope",
      "prime_capacity",
      "supporting_roles",
      "partnerships",
      "funding_priorities",
      "federal_history",
      "inferred",
      "gaps",
    ],
  },
};

export async function constructClientProfile(input: ClientProfileInput): Promise<ClientProfile> {
  const anthropic = getAnthropicClient();
  const response = await anthropic.messages.create({
    model: MODEL,
    // Document-heavy clients (rich intake + uploaded docs) overflowed 3000 and threw the
    // "truncated at max_tokens" error below -- ~8 of 28 on the backfill. Raised to 8000, the
    // same ceiling the matcher uses (engine.ts). max_tokens is a CAP, not a target, so a
    // light client still generates (and is billed for) only what its profile needs; only the
    // previously-truncating ones use the headroom.
    max_tokens: 8000,
    temperature: 0,
    system: CLIENT_PROFILE_SYSTEM_PROMPT,
    tools: [CLIENT_PROFILE_TOOL],
    tool_choice: { type: "tool", name: "submit_client_profile" },
    messages: [
      {
        role: "user",
        content: `Distill this organization's intake into a match-optimized client profile.\n\n${renderInput(
          input,
        ).slice(0, 60000)}`,
      },
    ],
  });

  if (response.stop_reason === "max_tokens") {
    throw new Error("Client-profile response truncated at max_tokens -- raise max_tokens");
  }
  const toolUse = response.content.find((b) => b.type === "tool_use");
  if (!toolUse || toolUse.type !== "tool_use") {
    throw new Error("Claude did not return a structured client profile");
  }
  return toolUse.input as ClientProfile;
}

// Populate clients.client_profile for one client (Stage 2). Loads the full row,
// assembles the Stage-1 input (pulling the stranded intake_data / notes free-text),
// refines, and stores the result. Safe to fire-and-forget via waitUntil.
//
// NULL-SAFE: constructClientProfile throws on failure (truncation / no tool-use);
// we catch it, log, and leave client_profile untouched (null) so the caller's
// create / edit / intake action still succeeds. Stage 3's backfill (or the next
// edit) re-attempts any null. Never read by the matcher in this stage.
export async function refreshClientProfileById(
  db: SupabaseClient,
  clientId: string,
): Promise<boolean> {
  const { data } = await db.from("clients").select("*").eq("id", clientId).single();
  if (!data) return false;
  try {
    const profile = await constructClientProfile(buildClientProfileInput(data as Client));
    // Attach community need-context (fail-safe: buildCommunityContext never throws and
    // returns null when the client's location does not resolve). Written in the SAME
    // update as the profile so a later refine can never leave a stale context behind.
    const community = await buildCommunityContext(data as Client);
    if (community) profile.community_context = community;
    // STAMPED IN THE SAME UPDATE AS THE PROFILE (0080), so the date and the thing it describes
    // can never disagree. This is the ONLY writer that sets it: the community-context patch
    // below rewrites the same jsonb without re-running the distillation, and stamping there
    // would claim a freshness the narrative does not have.
    const { error } = await db
      .from("clients")
      .update({ client_profile: profile, client_profile_generated_at: new Date().toISOString() })
      .eq("id", clientId);
    if (error) {
      console.error("Client-profile write failed for client", clientId, error.message);
      return false;
    }
    return true;
  } catch (err) {
    console.error(
      "Client-profile refine failed for client",
      clientId,
      err instanceof Error ? err.message : err,
    );
    return false; // leave client_profile as-is (null-safe)
  }
}

// Refresh ONLY the community need-context on an existing client_profile, WITHOUT
// re-running the LLM distillation (cheap: one Census call + a jsonb patch). Used by the
// one-shot backfill. Requires a present client_profile -- community context is read only
// when a profile exists (enrichMatchWithProfile gates on it), so a null profile is a
// no-op. Fail-safe: an unresolved location leaves the profile untouched.
export async function refreshClientCommunityContextById(
  db: SupabaseClient,
  clientId: string,
): Promise<"updated" | "no-profile" | "no-context" | "error"> {
  const { data } = await db.from("clients").select("*").eq("id", clientId).single();
  if (!data) return "error";
  const client = data as Client;
  if (!client.client_profile) return "no-profile"; // nothing to enrich yet
  const community = await buildCommunityContext(client);
  if (!community) return "no-context"; // location did not resolve
  const next: ClientProfile = { ...client.client_profile, community_context: community };
  const { error } = await db.from("clients").update({ client_profile: next }).eq("id", clientId);
  if (error) {
    console.error("Community-context write failed for client", clientId, error.message);
    return "error";
  }
  return "updated";
}

// Enrichment-facing rendering of a ClientProfile (Stage 4 redesign). This feeds
// the SEPARATE enrichment call (enrichMatchWithProfile) that runs AFTER the seat
// and score are fixed -- it grounds the outward narrative (why-this-org, concept,
// draft email) in the client's actual programs/mission/populations. It is NOT the
// occupancy path: the calibration proved a distilled profile pushes the scorer
// into strict itemized seat-matching that buries integrative-fit clients, so the
// profile no longer touches seat selection. Here it can only help -- richer client
// context for the narrative, with no channel to change the seat.
// Returns "" for a null/undefined profile (caller falls back to Phase-1 narrative).
export function formatClientProfileForEnrichment(profile: ClientProfile | null | undefined): string {
  if (!profile) return "";
  const lines: string[] = [];
  const joined = (a: string[] | undefined) => (a && a.length ? a.join(", ") : null);
  const push = (label: string, val: string | null | undefined) => {
    if (val && val.trim()) lines.push(`${label}: ${val.trim()}`);
  };

  push("Summary", profile.summary);
  push("Mission", profile.mission);
  push("Core capabilities", joined(profile.core_capabilities));

  if (Array.isArray(profile.program_areas) && profile.program_areas.length) {
    lines.push("Programs:");
    for (const p of profile.program_areas) {
      const demo = joined(p.target_demographics);
      const desc = p.description?.trim() ? ` -- ${p.description.trim().slice(0, 160)}` : "";
      lines.push(`  - [${p.status}] ${p.name}${demo ? ` (serves: ${demo})` : ""}${desc}`);
    }
  }
  push("Populations served", joined(profile.populations_served));

  const geo = profile.geographic_scope;
  if (geo) push("Geographic footprint", geo.footprint);

  // prime_capacity.rationale / supporting_roles are fine here (they only ground
  // narrative language about what the org does -- they cannot move the seat,
  // which is already fixed before this runs).
  if (profile.prime_capacity?.rationale?.trim()) {
    push("Capacity note", profile.prime_capacity.rationale);
  }
  push("Supporting roles it can genuinely fill", joined(profile.supporting_roles));
  push("Existing partnerships", joined(profile.partnerships));
  push("What they want to fund", joined(profile.funding_priorities));

  // Community need indicators (U.S. Census ACS). Grounds demonstrated-need language;
  // it describes the community, not the org's capacity, and cannot move the seat.
  const cc = profile.community_context;
  if (cc && Array.isArray(cc.geographies) && cc.geographies.length) {
    lines.push(`Community need context (${cc.source} ${cc.vintage}) -- describes the community served, not org capacity:`);
    for (const g of cc.geographies) {
      const i = g.indicators;
      const parts: string[] = [];
      if (i.population != null) parts.push(`pop ${i.population.toLocaleString("en-US")}`);
      if (i.median_household_income != null)
        parts.push(`median household income $${i.median_household_income.toLocaleString("en-US")}`);
      if (i.poverty_rate != null) parts.push(`poverty rate ${i.poverty_rate}%`);
      if (i.unemployment_rate != null) parts.push(`unemployment ${i.unemployment_rate}%`);
      if (parts.length) lines.push(`  - ${g.name}, ${g.state}: ${parts.join("; ")}`);
    }
  }

  // Federal shortage-area designations at the org's ADDRESS (HRSA). Point-in-polygon on
  // the geocoded location -- an eligibility/competitiveness signal for HRSA and
  // health-workforce grants; like the ACS block, it describes the location, not org
  // capacity, and cannot move the seat.
  if (cc?.shortage && Array.isArray(cc.shortage.designations) && cc.shortage.designations.length) {
    const parts = cc.shortage.designations.map((d) => {
      if (d.program === "HPSA") {
        return d.score != null ? `${d.discipline} HPSA (score ${d.score})` : `${d.discipline} HPSA`;
      }
      return d.name ? `${d.program}: ${d.name}` : d.program;
    });
    lines.push(
      `Federal shortage-area designations at the org's address (HRSA): ${parts.join("; ")} -- ` +
        `relevant to HRSA / health-workforce eligibility and scoring; describes the location, not org capacity.`,
    );
  }

  // HUD place-based designations at the org's ADDRESS (QCT/DDA). A federal distress /
  // underservedness marker -- strongest for housing and community-development funding.
  // Like the blocks above, it describes the location, not org capacity, and cannot move
  // the seat. Only surfaced when actually designated (a positive signal).
  const hud = cc?.hud;
  if (hud && (hud.qct === true || hud.dda === true)) {
    const tags: string[] = [];
    if (hud.qct === true) tags.push("a HUD Qualified Census Tract (QCT)");
    if (hud.dda === true) tags.push("a Difficult Development Area (DDA)");
    lines.push(
      `Place-based designation at the org's address (HUD): located in ${tags.join(" and ")} -- ` +
        `a federal distress/underservedness marker relevant to housing and community-development ` +
        `funding; describes the location, not org capacity.`,
    );
  }

  return (
    `\nCLIENT PROFILE (distilled context to GROUND the outreach narrative -- the seat, ` +
    `score, and eligibility are ALREADY decided and are NOT yours to revisit; use this only ` +
    `to make why-this-org, the concept, and the draft email specific and accurate to THIS client):\n` +
    `${lines.join("\n")}`
  );
}

// The "distilled profile first, else fall back to the structured fields" preface shared by every
// narrative renderer (section drafting + concept). The distilled profile is the priority signal;
// when it is absent the caller still grounds on the structured fields it renders below this line, so
// the fallback says exactly that rather than emitting nothing. Kept beside
// formatClientProfileForEnrichment so the two cannot drift.
export function renderClientProfileBlock(profile: ClientProfile | null | undefined): string {
  return profile
    ? formatClientProfileForEnrichment(profile)
    : "(No distilled client profile on file yet -- rely on the structured fields below.)";
}
