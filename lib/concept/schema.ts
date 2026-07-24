// Concept-proposal generation: the tool schema, system prompt, and input
// rendering. Mirrors the forced-tool-use pattern used everywhere structured
// output matters (lib/clients/profile.ts, lib/grants/engine.ts): the tool's
// input_schema IS the shape validation. This module is pure (no I/O) so it stays
// testable; store.ts does the DB reads and generate.ts makes the model call.

import type { Client, Grant, Prospect } from "@/types/database";
import { formatClientProfileForEnrichment } from "@/lib/clients/profile";

// The card's already-computed match signals -- fed as a STARTING hint (the match
// engine already reasoned about role/why/concept), not a constraint to re-derive.
export interface ConceptCardSignals {
  fit_score: number | null;
  proposed_role: string | null;
  why_this_org: string[] | null;
  concept_synopsis: string | null;
}

export interface ConceptGenerationInput {
  grant: Grant;
  client: Client;
  card: ConceptCardSignals;
  // Ecosystem orgs GRANTED tracks that plausibly fit as partners (each has a
  // verified source_url). The model prefers these over inventing names.
  prospectCandidates: Prospect[];
}

export const CONCEPT_PROPOSAL_SYSTEM_PROMPT = `You are GRANTED's concept-proposal generator. GRANTED is a U.S.-only grant consulting firm.

You are given ONE grant's NOFO and ONE client organization's profile. Produce a single
concept proposal: a concise, practical snapshot of how THIS client would actually pursue
THIS grant -- what they would propose to do, in what role, with which partners, at roughly
what scale and over what term. This is an internal review artifact for a GRANTED account
manager, not the full application.

CORE DISCIPLINE:
1. Compliance-first. Every element of the scope must map to something the NOFO actually
   allows and funds. Do not propose activities the NOFO does not fund. Ground eligibility
   and the applicant role in the NOFO's stated eligible entity types.
2. Capability-grounded. The proposal must reflect what the client's profile actually shows:
   their real programs, populations, capabilities, and reach. Do NOT invent capacity the
   client has not demonstrated. Where the profile is thin, stay conservative and general
   rather than fabricating specifics.
3. Snapshot, not a full proposal. Concise beats exhaustive. The scope is a "picture the
   project" narrative, not an eligibility restatement or boilerplate.
4. Estimates are estimates. Any dollar figure is an ESTIMATE; never present it as exact.

ROLE (two options only):
- role is "prime" or "partner": the client's suggested lead posture on THIS grant, grounded
  in the NOFO's eligible entity types and the client's prime capacity. If the client would
  more naturally support than lead, choose "partner" and make the leading organization clear
  in the partners list.

PARTNERS:
- Recommend the partners this application would need. Prefer naming a SPECIFIC organization
  when the fit is genuinely obvious. Draw first from the client's own cited partners, then
  from the candidate ecosystem organizations provided, then any real organization whose fit
  is clear. Never force-fit a named org: a wrong or dubious named partner is worse than an
  honest org-type ("workforce partner", "fiscal sponsor", "IHE anchor").
- For each partner, set EITHER name (a specific org) OR org_type_label (a type), not both.
  Give the role they would play and one to two sentences (max 50 words) on what they would do.
- source: "client_cited" if the org came from the client's own partners; "prospect" if from
  the provided candidate organizations; "suggested" for any org you named from your own
  knowledge. "suggested" orgs are UNVERIFIED and will be flagged for the account manager to
  confirm, so only name one when the fit is clear.

AMOUNTS & TERM:
- total_project_amount: an estimated total project cost, grounded in the NOFO's award range
  and the client's scale. A range is fine. Always an estimate.
- estimated_match: if the NOFO requires cost-share/match, the estimated non-federal match the
  client would need to bring (the NOFO's match requirement applied to the total). If no match
  is required, return null.
- project_term: the period of performance IF the NOFO states one (e.g. "3 years"). If the NOFO
  does not specify one, return null. Do not invent a term.

Write plainly and specifically to THIS client and THIS grant. Do not use em dashes.`;

export const CONCEPT_PROPOSAL_TOOL = {
  name: "submit_concept_proposal",
  description:
    "Return the concept proposal for this client and grant. Call this tool exactly once.",
  input_schema: {
    type: "object" as const,
    properties: {
      scope: {
        type: "string",
        description: "The practical application, 500 words max, compliance-mapped to the NOFO.",
      },
      role: { type: "string", enum: ["prime", "partner"] },
      total_project_amount: {
        type: "string",
        description: "Estimated total project cost (a range is fine). Always an estimate.",
      },
      estimated_match: {
        type: ["string", "null"],
        description: "Estimated non-federal match, or null if the NOFO requires none.",
      },
      project_term: {
        type: ["string", "null"],
        description: "Period of performance if the NOFO states one; null otherwise.",
      },
      partners: {
        type: "array",
        items: {
          type: "object",
          properties: {
            name: { type: ["string", "null"], description: "Specific org name, or null." },
            org_type_label: {
              type: ["string", "null"],
              description: "Org-type label when unnamed (e.g. 'workforce partner'), or null.",
            },
            role: { type: "string" },
            description: { type: "string", description: "Max 50 words: what this partner does." },
            source: { type: "string", enum: ["client_cited", "prospect", "suggested"] },
          },
          required: ["name", "org_type_label", "role", "description", "source"],
        },
      },
    },
    required: ["scope", "role", "total_project_amount", "estimated_match", "project_term", "partners"],
  },
};

const val = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);
const listVal = (v: unknown): string | null =>
  Array.isArray(v) ? v.filter((x) => typeof x === "string" && x.trim()).join(", ") || null : null;

// The grant's NOFO: shredded structured fields (the reliable spine) plus an
// excerpt of raw_text, which is where allowable activities and priority language
// actually live (they are not discrete columns). Capped so the client block and
// the model's budget still fit.
function renderGrant(grant: Grant): string {
  const ideal = grant.ideal_applicant_profile;
  const archetypes =
    ideal?.archetypes
      ?.map(
        (a) =>
          `  - ${a.label}: ideal prime = ${a.ideal_prime_shape}; core role = ${a.core_role}; partner seats = ${
            a.partner_seats?.join("; ") || "none listed"
          }`,
      )
      .join("\n") || null;

  const lines = [
    ["Title", val(grant.title)],
    ["Funder", val(grant.funder)],
    ["Funding opportunity number", val(grant.fon)],
    ["Eligible entity types", listVal(grant.eligible_entity_types)],
    ["Geographic eligibility", val(grant.geographic_eligibility)],
    ["Award range", [val(grant.award_range_min), val(grant.award_range_max)].filter(Boolean).join(" to ") || null],
    ["Expected number of awards", val(grant.num_awards)],
    ["Cost-share / match requirement", val(grant.cost_share)],
    ["Period of performance", val(grant.period_of_performance)],
    ["Focus areas", listVal(grant.focus_areas)],
    ["High-value scoring criteria", listVal(grant.scoring_criteria_high_value)],
    ["Core funded role", val(ideal?.core_funded_role)],
    ["Ideal-applicant summary", val(ideal?.summary)],
  ]
    .filter(([, v]) => v)
    .map(([k, v]) => `${k}: ${v}`);

  if (archetypes) lines.push(`Applicant archetypes / partner seats:\n${archetypes}`);

  const raw = val(grant.raw_text);
  const rawBlock = raw
    ? `\n=== NOFO FULL TEXT (excerpt -- read for ALLOWABLE ACTIVITIES and FUNDING PRIORITIES) ===\n${raw.slice(0, 40000)}`
    : `\n(No full NOFO text on file -- shred_depth=${grant.shred_depth}. Reason on plain summaries.)`;

  return `=== GRANT / NOFO (structured) ===\n${lines.join("\n")}${rawBlock}`;
}

// The client: the distilled profile when present (the priority signal), always
// backed by the structured fields, so a client whose profile has not been refined
// yet still generates something grounded.
function renderClient(client: Client): string {
  const profileBlock = client.client_profile
    ? formatClientProfileForEnrichment(client.client_profile)
    : "(No distilled client profile on file yet -- rely on the structured fields below.)";

  const intake = (client.intake_data ?? {}) as Record<string, unknown>;
  const structured = [
    ["Org type", val(client.org_type)],
    [
      "Location",
      [client.location_city, client.location_county, client.location_state].filter(Boolean).join(", ") || null,
    ],
    ["Service area", listVal(client.service_area)],
    ["Annual budget", val(client.annual_budget)],
    ["Match / cost-share capacity", val(client.match_cost_share_capacity)],
    ["Primary funding needs", listVal(client.primary_funding_needs)],
    ["Project stage", val(client.project_stage)],
    ["Self-reported federal grant history", val(client.federal_grant_history)],
    ["Mission (intake)", val(intake.mission)],
    ["Funding need (intake)", val(intake.funding_need)],
    ["Cited partnerships (intake)", val(intake.partnerships)],
  ]
    .filter(([, v]) => v)
    .map(([k, v]) => `${k}: ${v}`)
    .join("\n");

  return `=== CLIENT ORGANIZATION: ${client.name} ===\n${profileBlock}\n\n--- Structured fields ---\n${
    structured || "(no structured fields on file)"
  }`;
}

function renderCandidates(prospects: Prospect[]): string {
  if (!prospects.length) {
    return "=== CANDIDATE PARTNER ORGANIZATIONS (GRANTED-tracked) ===\n(none on file for this client's area -- lean on the client's own partners or honest org-types)";
  }
  const rows = prospects
    .map(
      (p) =>
        `  - ${p.name}${p.org_type ? ` (${p.org_type})` : ""}${
          p.location_state ? `, ${[p.location_county, p.location_state].filter(Boolean).join(", ")}` : ""
        }${p.capability_summary ? `: ${p.capability_summary.slice(0, 200)}` : ""}`,
    )
    .join("\n");
  return `=== CANDIDATE PARTNER ORGANIZATIONS (GRANTED-tracked; prefer these when they fit; source="prospect") ===\n${rows}`;
}

function renderSignals(card: ConceptCardSignals): string {
  const why = (card.why_this_org ?? []).filter(Boolean);
  const lines = [
    ["Match fit score (1-3)", card.fit_score != null ? String(card.fit_score) : null],
    ["Engine-proposed role", val(card.proposed_role)],
    ["Concept synopsis (starting hint)", val(card.concept_synopsis)],
  ]
    .filter(([, v]) => v)
    .map(([k, v]) => `${k}: ${v}`);
  if (why.length) lines.push(`Why this org (starting hints):\n${why.map((w) => `  - ${w}`).join("\n")}`);
  if (!lines.length) return "";
  return `=== STARTING SIGNALS FROM THE MATCH (hints to refine, not constraints) ===\n${lines.join("\n")}`;
}

export function renderConceptInput(input: ConceptGenerationInput): string {
  return [
    renderGrant(input.grant),
    "",
    renderClient(input.client),
    "",
    renderCandidates(input.prospectCandidates),
    "",
    renderSignals(input.card),
  ]
    .filter(Boolean)
    .join("\n");
}
