import { getAnthropicClient, MODEL } from "@/lib/anthropic";
import type { ConceptProposal, ConceptProposalPartner } from "@/types/database";
import {
  CONCEPT_PROPOSAL_SYSTEM_PROMPT,
  CONCEPT_PROPOSAL_TOOL,
  renderConceptInput,
  type ConceptGenerationInput,
} from "./schema";

export const CONCEPT_MODEL = MODEL;

// Cap a description to N words deterministically (the model is told <=50, this
// enforces it in code the way the alert enrichment clamps its own fields).
function truncateWords(s: string, max: number): string {
  const words = s.trim().split(/\s+/);
  return words.length <= max ? s.trim() : words.slice(0, max).join(" ") + "...";
}

const asString = (v: unknown): string => (typeof v === "string" ? v.trim() : "");
const asNullableString = (v: unknown): string | null => {
  const s = asString(v);
  return s ? s : null;
};

// The tool input_schema is the shape guarantee; on top of it we coerce defensively
// so a partial/odd payload can never crash the render or the store. Mirrors the
// "manual validation + deterministic fallback" convention (lib/alerts/enrich.ts).
export function normalizeConceptProposal(raw: unknown): ConceptProposal {
  const r = (raw ?? {}) as Record<string, unknown>;
  const role = r.role === "partner" ? "partner" : "prime";

  const partnersRaw = Array.isArray(r.partners) ? r.partners : [];
  const partners: ConceptProposalPartner[] = partnersRaw
    .map((p): ConceptProposalPartner => {
      const pr = (p ?? {}) as Record<string, unknown>;
      const source =
        pr.source === "client_cited" || pr.source === "prospect" || pr.source === "manual"
          ? pr.source
          : "suggested";
      return {
        name: asNullableString(pr.name),
        org_type_label: asNullableString(pr.org_type_label),
        role: asString(pr.role) || "partner",
        description: truncateWords(asString(pr.description), 50),
        source,
      };
    })
    // A partner with neither a name nor a type label carries no information.
    .filter((p) => p.name || p.org_type_label);

  const hookRaw = asString(r.hook);

  return {
    scope: asString(r.scope),
    role,
    total_project_amount: asString(r.total_project_amount),
    estimated_match: asNullableString(r.estimated_match),
    project_term: asNullableString(r.project_term),
    // A hook is a teaser, not the plan — clamp hard even though the prompt says <=25.
    hook: hookRaw ? truncateWords(hookRaw, 30) : null,
    partners,
  };
}

// Generate the concept proposal for one client x grant. Forced single tool-call,
// temperature 0.3 (internal review draft: a touch of prose warmth, but the role /
// amounts / term stay grounded). Throws on truncation or a missing tool-use so the
// caller (store.ts) records status='error' and the AM can retry -- there is no
// silent partial. Fails fast in the sandbox (no ANTHROPIC_API_KEY) via
// getAnthropicClient(), which is exactly why generation is verified on a real
// deploy, never here.
export async function generateConceptProposal(input: ConceptGenerationInput): Promise<ConceptProposal> {
  const anthropic = getAnthropicClient();
  const response = await anthropic.messages.create({
    model: MODEL,
    max_tokens: 4000,
    temperature: 0.3,
    system: CONCEPT_PROPOSAL_SYSTEM_PROMPT,
    tools: [CONCEPT_PROPOSAL_TOOL],
    tool_choice: { type: "tool", name: "submit_concept_proposal" },
    messages: [
      {
        role: "user",
        content: `Generate the concept proposal for this client and grant.\n\n${renderConceptInput(input).slice(
          0,
          80000,
        )}`,
      },
    ],
  });

  if (response.stop_reason === "max_tokens") {
    throw new Error("Concept-proposal response truncated at max_tokens -- raise max_tokens");
  }
  const toolUse = response.content.find((b) => b.type === "tool_use");
  if (!toolUse || toolUse.type !== "tool_use") {
    throw new Error("Claude did not return a structured concept proposal");
  }
  return normalizeConceptProposal(toolUse.input);
}
