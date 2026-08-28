// ── Client-safe fit narrative (Step C) ───────────────────────────────────────────────────────────
//
// WHAT THIS IS. When the IntellEngine QA pass APPLIES a demote, the card's fit-factor paragraph is today
// assembled from three engine-derived pieces (lead / a templated blocking sentence / consortium prose),
// which reads as two voices — the engine's optimistic "why it fits" over a demote it never rewrote. This
// module lets the SAME grounded QA structuring call emit ONE additional field, `narrative`: a single
// client-safe paragraph that IS the match justification — rationale → grounding reality → proposed role →
// net score, one voice. It is NOT a second synthesizer (no extra model call, no re-reading of two finished
// texts): it is one more field on the phase-2 tool schema, written by the model that just read the .gov
// sources, so it can't drift from a fact it didn't have.
//
// TWO-PART FAITHFULNESS GUARD (the whole point):
//   (a) Never drift from or soften a grounded fact — "cannot prime" never becomes "may face challenges".
//       The prompt pins it to the analysis; the eval is the trust gate; and structurally the narrative
//       never touches qa_fit_score, so a drifted paragraph can under-explain a demote but never un-demote
//       it (the number stays authoritative).
//   (b) Never internal-framing / machinery language — it reads as advice spoken TO the client, never
//       "tell the client X", "position as Y", "the engine", "QA", "unverified", "verdict". The prompt
//       forbids it AND `narrativeGuard` is a deterministic runtime net: on any forbidden token it NULLS the
//       narrative, so a slip falls back to today's engine paragraph rather than leaking staff voice onto a
//       client page. (Console and client report are 1-for-1 — anything shown is shown to the client.)
//
// FLAG-OFF IS BYTE-IDENTICAL. `FIT_NARRATIVE_ENABLED` gates whether the field is even added to the tool
// schema and whether the addendum is appended, so off → the phase-2 request/system are exactly today's and
// no narrative is generated, stored, or displayed. Persistence + display are a separate, later PR.

// The tool-schema property shape (a plain JSON-schema object). Anthropic tool input_schema `properties`.
export interface JsonSchemaProperty {
  type: string;
  description?: string;
}

export function fitNarrativeEnabled(): boolean {
  return process.env.FIT_NARRATIVE_ENABLED === "true";
}

// The `narrative` field appended to the phase-2 SUBMIT tool when the flag is on. Optional (never in
// `required`) so a model that omits it does NOT break structuring — a missing narrative simply falls back
// to the engine paragraph, same as a guard-failed one.
export const NARRATIVE_TOOL_PROPERTY: JsonSchemaProperty = {
  type: "string",
  description:
    "CLIENT-FACING. For a DEMOTE only: one tight integrated paragraph (AT MOST ~175 words / ~1,000 chars) a " +
    "client reads as the match justification — rationale, the grounding reality that changes the picture, the " +
    "role we'd actually pursue, and the net score stated plainly. Economical, not exhaustive. Written AS advice " +
    "to the reader; never internal framing (no 'tell the client', 'position as', no mention of the engine/QA/" +
    "score machinery). Leave empty for affirm/flag/unverified.",
};

// Appended to STRUCTURE_SYSTEM_PROMPT only when the flag is on. This is the spec for the client paragraph.
export const NARRATIVE_STRUCTURE_ADDENDUM = `

CLIENT NARRATIVE (the \`narrative\` field) — write this ONLY when your verdict is "demote"; otherwise leave it empty.

LENGTH — HARD CAP: at most ~175 words / ~1,000 characters. One tight paragraph a client can read at a glance, not a memo. Be economical: make the score/role shift and the single most important next move unmistakable, state the grounding fact and any prohibited-use limits in brief, and do NOT enumerate every sub-point, dollar figure, or caveat — name the one or two that decide the play and stop. Every sentence must earn its place. A shorter faithful paragraph beats a complete one.

Write ONE integrated paragraph that a client reads as the whole justification for this match. It must flow, in this order:
  1. Rationale — why this grant genuinely fits this organization (draw on the engine's confirmed positives: entity type, registrations, track record, no cost-share, etc.).
  2. The grounding reality — the authoritative fact your analysis established that changes or confirms the picture (the allocation status, prohibited uses, whatever you verified). State it in full force.
  3. The role we'd actually pursue — prime vs. co-applicant vs. sub / fiscal-agent-by-MOU, as applicable, and what the structure means in practice (the fundable lane, what to negotiate).
  4. The net score, stated plainly — where the score or role shifted, that shift IS the justification, so make it the point, not a footnote.

TWO HARD RULES:
  (a) FAITHFULNESS OVER POLISH. Never soften or drift from a grounded fact. If the analysis found the client CANNOT prime, the paragraph says it cannot — never "may face challenges", "could be difficult", "may need to consider". Preserve every hard eligibility fact and prohibited-use fact at full strength. Introduce NO new specific claim (no dollar figures, citations, dates, or program details) beyond what the analysis and the grant context give you.
  (b) DIRECT CLIENT VOICE, NEVER INTERNAL FRAMING. Write it as advice spoken to the reader. Say the thing directly — do NOT say "tell the client", "position this as", "we should frame", "note that they". Do NOT mention the engine, the scorer, the model, the QA pass, a "verdict", an "unverified" state, a "fit score", or any scoring machinery. No meta-commentary about your own analysis. Fold in the ONE or TWO most decisive strategic points (the fundable lane, the key thing to negotiate) as advice to the reader — briefly, not an exhaustive list; leave the rest for the conversation.

Good: "Mississippi County is the kind of applicant Byrne JAG is built for — a county government with active SAM registration and DOJ grant history … but on the FY2026 Arkansas allocation table it carries an asterisk … so it cannot apply as a standalone prime. The path is a formal MOU with Blytheville naming a single fiscal agent …"
Bad: "The engine scored this a 3, but QA found the county is disparate, so position this to the client as a partnership opportunity."`;

// Build the phase-2 structuring config: the tool (with or without the narrative property) and the system
// prompt (with or without the addendum). OFF returns the base tool/system UNCHANGED (referential identity
// is not required, but the value is byte-identical) — the revert guarantee. `baseTool` is the frozen
// SUBMIT_TOOL; we shallow-clone and add the property + description only when on, never mutating the base.
export function structureConfig<T extends { input_schema: { properties: Record<string, unknown> } }>(
  narrativeOn: boolean,
  baseTool: T,
  baseSystem: string,
): { tool: T; system: string } {
  if (!narrativeOn) return { tool: baseTool, system: baseSystem };
  const tool = {
    ...baseTool,
    input_schema: {
      ...baseTool.input_schema,
      properties: { ...baseTool.input_schema.properties, narrative: NARRATIVE_TOOL_PROPERTY },
    },
  } as T;
  return { tool, system: baseSystem + NARRATIVE_STRUCTURE_ADDENDUM };
}

// Deterministic runtime net for rule (b). Any of these substrings (case-insensitive) means the model leaked
// internal framing or scoring machinery into a CLIENT-facing paragraph — we drop the whole narrative rather
// than ship it, and the card falls back to today's engine paragraph. Kept TIGHT (unambiguous machinery /
// staff-instruction phrases) so it does not null a legitimate client narrative; the eval catches subtler
// softening/framing the scan can't. Ordered roughly by likelihood.
export const FORBIDDEN_NARRATIVE_MARKERS: readonly string[] = [
  // Scoring / QA machinery — never client-facing
  "the engine",
  "the scorer",
  "intellengine",
  "qa pass",
  "qa found",
  "qa ran",
  "the verdict",
  "unverified",
  "manual check",
  "fit score",
  "fit_score",
  "qa_fit",
  "score derivation",
  "the analysis found",
  "we scored",
  "we rated",
  "we assessed this",
  "the model scored",
  // Staff-instruction framing — must read as advice TO the reader, not ABOUT them
  "tell the client",
  "let the client know",
  "position this",
  "position it as",
  "position as",
  "frame this",
  "frame it as",
  "pitch this",
  "spin this",
  "note to staff",
  "for staff",
  "internal note",
  "internally,",
];

// Returns the trimmed narrative when it is present and clean; null when absent, empty, or it trips the
// framing scan. Null = "show the engine paragraph" (the fail-safe), never a partial/leaky client string.
export function narrativeGuard(raw: string | null | undefined): string | null {
  const text = (raw ?? "").trim();
  if (!text) return null;
  const haystack = text.toLowerCase();
  for (const marker of FORBIDDEN_NARRATIVE_MARKERS) {
    if (haystack.includes(marker)) return null;
  }
  return text;
}
