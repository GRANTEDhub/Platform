// ── Client-safe verdict narrative (the go/no-go REASONING body) ──────────────────────────────────
//
// WHAT THIS IS. Every matched grant leads with a one-line directional VERDICT — "Go for NWACC." /
// "Marginal for NWACC." / "No-go for NWACC." — and this paragraph is the REASONING that follows it. The
// verdict LABEL is deterministic and lives elsewhere (`buildVerdict`, pinned to the displayed score, so
// prose and score can NEVER disagree by construction). This module is only the reasoning body: the SAME
// grounded QA structuring call emits ONE extra field, `narrative` — 2–5 sentences of plain prose that open
// with the single most decisive reason and, for a go/marginal, name the real hurdle honestly. It is NOT a
// second synthesizer (no extra model call, no re-reading of finished texts): it is one field on the phase-2
// tool schema, written by the model that just read the .gov sources, so it can't drift from a fact it
// didn't have. Written for EVERY verdict it reaches (affirm / demote / flag), not just a demote.
//
// THE MODEL NEVER AUTHORS THE CALL. The card states the directional label; the narrative writes reasoning
// UNDER a call it cannot override (Shannon, 2026-09-01 — "the score sets the directional call; the prose
// writes the reasoning"). So the paragraph does not restate "Go/No-go", does not open with the org name,
// and carries no numeric score — it starts with the reason. That is the pin: no guard, no fallback, no way
// for the body to flip the verdict.
//
// TWO-PART FAITHFULNESS GUARD (the whole point):
//   (a) Never drift from or soften a grounded fact — "cannot prime" never becomes "may face challenges".
//       The prompt pins it to the analysis; the eval is the trust gate; and structurally the narrative
//       never touches qa_fit_score, so a drifted paragraph can under-explain a call but never move the
//       number (the score stays authoritative). Distinguish entity-eligibility from competitive fit — an
//       IHE can be entity-eligible yet functionally wrong, and the paragraph must say both.
//   (b) Never internal-framing / machinery language — it reads as advice spoken TO the client, never
//       "tell the client X", "position as Y", "the engine", "QA", "unverified", "verdict". The prompt
//       forbids it AND `narrativeGuard` is a deterministic runtime net: on any forbidden token it NULLS the
//       narrative, so a slip falls back to today's engine paragraph rather than leaking staff voice onto a
//       client page. (Console and client report are 1-for-1 — anything shown is shown to the client.)
//
// FLAG-OFF IS BYTE-IDENTICAL. `FIT_NARRATIVE_ENABLED` gates whether the field is even added to the tool
// schema and whether the addendum is appended, so off → the phase-2 request/system are exactly today's and
// no narrative is generated, stored, or displayed.

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
    "CLIENT-FACING reasoning body for the go/no-go verdict. Write it for EVERY verdict you reach (affirm, " +
    "demote, or flag); leave empty only for an unverified verdict. Two to five sentences of plain prose — NO " +
    "bullets, NO numeric score. The card ITSELF states the directional call ('Go for X' / 'Marginal for X' / " +
    "'No-go for X'), so do NOT open with that label or the org name — open with the single most DECISIVE reason. " +
    "If a hard disqualifier drives the call, lead with it (never geography). Distinguish entity-eligibility from " +
    "competitive fit. For a go or marginal, name the real hurdle honestly. Decisive, not hedged. Written AS " +
    "advice to the reader; never internal framing (no 'tell the client', 'position as', no engine/QA/score " +
    "machinery).",
};

// Appended to STRUCTURE_SYSTEM_PROMPT only when the flag is on. This is the spec for the reasoning paragraph.
export const NARRATIVE_STRUCTURE_ADDENDUM = `

VERDICT NARRATIVE (the \`narrative\` field) — write this for EVERY verdict you reach (affirm, demote, or flag). Leave it empty ONLY when your verdict is "unverified".

WHAT IT IS: the plain-language REASONING body under a one-line directional verdict the card already states for you — "Go for <client>." / "Marginal for <client>." / "No-go for <client>.". You do NOT write that label. You do NOT open with the client's name or a "go/no-go" word. You write the reasoning that JUSTIFIES the call, opening with the reason itself. The number is set elsewhere and is authoritative — never state a numeric score and never argue the call up or down; explain it.

LENGTH: two to five sentences, one paragraph, prose only. No bullet lists, no headings, no dollar tables. A client reads it at a glance. Be economical — name the one or two facts that decide the play and stop.

WRITE IT IN THIS SHAPE:
  1. The single most DECISIVE reason FIRST. If a hard disqualifier drives the call — wrong entity type, missing designation, wrong applicant door, deadline passed, too few awards, no genuine match — lead with THAT and you can stop there. Lead with the disqualifier, never with geography.
  2. ELIGIBLE vs. COMPETITIVE are different things — say both when they diverge. "Entity-eligible as an IHE, but this is a fossil-energy R&D grant and <client> has no research faculty or federal R&D history, so it's functionally wrong." Do not let entity-eligibility read as a go, and do not let a competitive weakness read as an eligibility bar.
  3. For a go or a marginal, name the REAL hurdle honestly — the mandatory track they lack, the partner or match to lock before the deadline, the structure to negotiate. A marginal that hides its hurdle is worse than useless.

TWO HARD RULES:
  (a) FAITHFULNESS OVER POLISH. Never soften or drift from a grounded fact. If <client> CANNOT prime, say it cannot — never "may face challenges", "could be difficult", "may need to consider". Preserve every hard eligibility fact and prohibited-use fact at full strength. Introduce NO new specific claim (no dollar figures, citations, dates, or program details) beyond what the analysis and the grant context give you.
  (b) DIRECT CLIENT VOICE, NEVER INTERNAL FRAMING. Write it as advice spoken to the reader. Say the thing directly — do NOT say "tell the client", "position this as", "we should frame", "note that they". Do NOT mention the engine, the scorer, the model, the QA pass, a "verdict", an "unverified" state, a "fit score", or any scoring machinery. No meta-commentary about your own analysis.

Good (no-go): "This is a fossil-energy R&D program that expects a principal investigator and research faculty. NWACC is a two-year teaching college with no research capacity, no federal R&D history, and no energy-research program — entity-eligible as an institution of higher education, but functionally wrong for the work this funds."
Good (marginal): "Genuinely in the workforce-development lane and no formal match is required, and there are real regional water utilities to partner with. But the strongest fit is a narrower project area than it first appears, and the two real hurdles are a mandatory HAZWOPER training track NWACC does not currently run and locking an employer and school-district partner before the deadline."
Bad: "The engine scored this a 3, but QA found the college is disparate, so position this to the client as a workforce opportunity."`;

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
