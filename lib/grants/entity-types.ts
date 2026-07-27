// Prospecting entity-type targeting (#208 follow-up). Before enumerating candidate
// orgs, identify WHICH entity type(s) can be the PRIME applicant on a grant and aim
// the search at just those -- a city-only grant hunts municipalities, not charities --
// instead of enumerating every type and filtering. This module is the routing backbone:
// Phase 1 uses it to gate the nonprofit directory; per-type enumeration sources (IPEDS
// for colleges, Census for local govs, NTD for transit, CMS for hospitals) plug in
// behind these types next. Graceful: deriveTargetEntityTypes returns [] on any failure
// so discovery falls back to its prior broad behavior and never regresses to zero.

import { getAnthropicClient, MODEL } from "@/lib/anthropic";
import type { Grant } from "@/types/database";

// The normalized prime entity types the engine targets. "nonprofit" is the FULL 501(c)
// family (charities AND (c)(4)/(5)/(6)/... -- deliberately NOT charities only). Kept
// coarse on purpose: enough to route enumeration, not a full NAICS-style taxonomy.
export type EntityType =
  | "nonprofit"
  | "city"
  | "county"
  | "state_government"
  | "higher_education"
  | "school_district"
  | "transit_agency"
  | "hospital"
  | "tribal"
  | "special_district";

const ENTITY_META: Record<EntityType, { label: string }> = {
  nonprofit: { label: "Nonprofit (any 501(c), not only charities)" },
  city: { label: "City / municipal or township government" },
  county: { label: "County government" },
  state_government: { label: "State government or agency" },
  higher_education: { label: "College or university (incl. community colleges)" },
  school_district: { label: "K-12 school district / local education agency" },
  transit_agency: { label: "Public transit authority or agency" },
  hospital: { label: "Hospital or health system" },
  tribal: { label: "Tribal government / Native American entity" },
  special_district: { label: "Special district or regional authority (economic/regional development, port, water)" },
};

export const ALL_ENTITY_TYPES = Object.keys(ENTITY_META) as EntityType[];
const ENTITY_SET = new Set<string>(ALL_ENTITY_TYPES);
export function entityTypeLabel(t: EntityType): string {
  return ENTITY_META[t].label;
}
export function isEntityType(s: string): s is EntityType {
  return ENTITY_SET.has(s);
}

const SYSTEM = `You identify which TYPES OF ORGANIZATION are eligible to be the PRIME applicant (the lead applicant that holds the award) on a U.S. federal grant. Return only types that can PRIME, from this fixed list:

- nonprofit: any 501(c) nonprofit -- charities AND social-welfare / business-league / other subsections, NOT only 501(c)(3) charities
- city: city, municipal, or township government
- county: county government
- state_government: state government or state agency
- higher_education: college or university, including community colleges
- school_district: K-12 school district / local education agency
- transit_agency: public transit authority or agency
- hospital: hospital or health system
- tribal: tribal government or Native American entity
- special_district: special district or regional authority (economic/regional development district, council of governments, port, water, etc.)

Rules:
- Base this on the grant's stated eligibility and ideal-applicant profile. Include EVERY type that can legitimately prime; a grant often allows several.
- Prime only -- do NOT include a type that can only be a sub/partner.
- If eligibility is broad or unrestricted, return the types most likely to actually apply given the funded role, not all ten.
- Return via the submit_entity_types tool, most-likely-prime first.`;

// Derive the eligible PRIME entity type(s) for a grant via a small LLM call over its
// stated eligibility + ideal-applicant profile. Used to target enumeration (today: gate
// the nonprofit directory). Graceful: returns [] on any failure so discovery proceeds
// with its prior broad behavior.
export async function deriveTargetEntityTypes(grant: Grant): Promise<EntityType[]> {
  try {
    const profile = grant.ideal_applicant_profile;
    const shapes = (profile?.archetypes ?? [])
      .map((a) => `- ${a.label}: ${a.ideal_prime_shape}`)
      .join("\n");
    const summary = [
      `Title: ${grant.title ?? "Untitled"}`,
      grant.funder ? `Funder: ${grant.funder}` : "",
      (grant.eligible_entity_types || []).length
        ? `Eligible entity types: ${(grant.eligible_entity_types || []).join("; ")}`
        : "",
      grant.geographic_eligibility ? `Geographic eligibility: ${grant.geographic_eligibility}` : "",
      profile?.core_funded_role ? `Core funded role: ${profile.core_funded_role}` : "",
      profile?.eligibility_note ? `Eligibility note: ${profile.eligibility_note}` : "",
      shapes ? `Ideal prime shapes:\n${shapes}` : "",
    ]
      .filter(Boolean)
      .join("\n");

    const anthropic = getAnthropicClient();
    const resp = await anthropic.messages.create({
      model: MODEL,
      max_tokens: 200,
      temperature: 0,
      system: SYSTEM,
      tools: [
        {
          name: "submit_entity_types",
          description: "Return the eligible PRIME entity types. Call exactly once.",
          input_schema: {
            type: "object",
            properties: {
              entity_types: { type: "array", items: { type: "string", enum: ALL_ENTITY_TYPES } },
            },
            required: ["entity_types"],
          },
        },
      ],
      tool_choice: { type: "tool", name: "submit_entity_types" },
      messages: [{ role: "user", content: summary }],
    });
    const toolUse = resp.content.find((b) => b.type === "tool_use");
    const raw =
      toolUse && toolUse.type === "tool_use"
        ? ((toolUse.input as { entity_types?: string[] }).entity_types ?? [])
        : [];
    const seen = new Set<string>();
    const out: EntityType[] = [];
    for (const s of raw) {
      if (isEntityType(s) && !seen.has(s)) {
        seen.add(s);
        out.push(s);
      }
    }
    return out;
  } catch (err) {
    console.error("[deriveTargetEntityTypes] failed:", err);
    return [];
  }
}
