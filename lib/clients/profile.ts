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
    ["Mission / what they're looking for", str(intake.funding_need)],
    ["Priority areas", list(intake.priority_areas) ?? list(client.primary_funding_needs)],
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
    max_tokens: 3000,
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
    const { error } = await db
      .from("clients")
      .update({ client_profile: profile })
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

// Matcher-facing rendering of a ClientProfile (Stage 4a). SUPPLEMENTARY capacity
// signal appended to clientContext to help the model pick the RIGHT seat -- it does
// NOT change the seat rubric, the closed menu, or the clamp (those are unchanged;
// this is pure additional input). Deliberately a SUBSET, not the full JSON:
//  - drops inferred[] (provenance, not decision-relevant),
//  - drops fiscal_notes (duplicates the raw Annual Budget / Match / RUCC lines),
//  - drops funding_priorities (duplicates the raw Primary Funding Needs line),
//  - drops federal_history (that is the Stage 4b precedence flip -- kept out of 4a).
// Returns "" for a null/undefined profile so clientContext is byte-identical when
// no profile exists (null-safe). The leading "\n" separates it from the SAM line.
export function formatClientProfileForMatcher(profile: ClientProfile | null | undefined): string {
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
  if (geo) push("Geographic scope", `${geo.footprint?.trim() || "unspecified"} (${geo.scale})`);

  const pc = profile.prime_capacity;
  if (pc) {
    const cond = pc.conditional_on?.trim() ? `; conditional on: ${pc.conditional_on.trim()}` : "";
    push(
      "Prime capacity",
      `${pc.can_prime ? "CAN prime" : "cannot prime as lead"} -- ${pc.rationale?.trim() ?? ""}${cond}`,
    );
  }
  push("Supporting roles it can genuinely fill", joined(profile.supporting_roles));
  push("Existing partnerships", joined(profile.partnerships));
  push(
    "Data gaps (thin/uncertain -- score conservatively where a seat depends on these)",
    joined(profile.gaps),
  );

  return (
    `\nCLIENT PROFILE (distilled from this client's intake -- supplementary capacity signal to help you ` +
    `pick the RIGHT seat from the menu; it does NOT change the seat rules, the menu, or the ceilings):\n` +
    `${lines.join("\n")}\n` +
    `prime_capacity / supporting_roles describe GENERAL capacity, not a seat assignment -- you still ` +
    `choose seat_ref for THIS grant, and can_prime never lifts a ceiling.`
  );
}
