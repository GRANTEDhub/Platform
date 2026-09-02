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

import type { FactorScores } from "@/types/database";

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
    "competitive fit. For a go or marginal, name the real hurdle honestly. Decisive, not hedged. Do NOT " +
    "enumerate every seat/capability — name the one or two that decide it and finish the thought. Never write " +
    "an internal seat/role code (S0_2, P0). Written AS advice to the reader; never internal framing (no 'tell " +
    "the client', 'position as', no engine/QA/score machinery).",
};

// Appended to STRUCTURE_SYSTEM_PROMPT only when the flag is on. This is the spec for the reasoning paragraph.
export const NARRATIVE_STRUCTURE_ADDENDUM = `

VERDICT NARRATIVE (the \`narrative\` field) — write this for EVERY verdict you reach (affirm, demote, or flag). Leave it empty ONLY when your verdict is "unverified".

WHAT IT IS: the plain-language REASONING body under a one-line directional verdict the card already states for you — "Go for <client>." / "Marginal for <client>." / "No-go for <client>.". You do NOT write that label. You do NOT open with the client's name or a "go/no-go" word. You write the reasoning that JUSTIFIES the call, opening with the reason itself. The number is set elsewhere and is authoritative — never state a numeric score and never argue the call up or down; explain it.

LENGTH: two to five sentences, one paragraph, prose only. No bullet lists, no headings, no dollar tables. A client reads it at a glance. Be economical — name the one or two facts that decide the play and stop, and COMPLETE the thought inside that budget. Do NOT enumerate the seats or list every capability the org could fill: naming them all overruns the space (the paragraph gets cut off mid-sentence) and leaks internal structure. Pick the one or two that decide it.

WRITE IT IN THIS SHAPE:
  1. The single most DECISIVE reason FIRST. If a hard disqualifier drives the call — wrong entity type, missing designation, wrong applicant door, deadline passed, too few awards, no genuine match — lead with THAT and you can stop there. Lead with the disqualifier, never with geography.
  2. ELIGIBLE vs. COMPETITIVE are different things — say both when they diverge. "Entity-eligible as an IHE, but this is a fossil-energy R&D grant and <client> has no research faculty or federal R&D history, so it's functionally wrong." Do not let entity-eligibility read as a go, and do not let a competitive weakness read as an eligibility bar.
  3. For a go or a marginal, name the REAL hurdle honestly — the mandatory track they lack, the partner or match to lock before the deadline, the structure to negotiate. A marginal that hides its hurdle is worse than useless.

TWO HARD RULES:
  (a) FAITHFULNESS OVER POLISH. Never soften or drift from a grounded fact. If <client> CANNOT prime, say it cannot — never "may face challenges", "could be difficult", "may need to consider". Preserve every hard eligibility fact and prohibited-use fact at full strength. Introduce NO new specific claim (no dollar figures, citations, dates, or program details) beyond what the analysis and the grant context give you.
  (b) DIRECT CLIENT VOICE, NEVER INTERNAL FRAMING. Write it as advice spoken to the reader. Say the thing directly — do NOT say "tell the client", "position this as", "we should frame", "note that they". Do NOT mention the engine, the scorer, the model, the QA pass, a "verdict", an "unverified" state, a "fit score", or any scoring machinery. No meta-commentary about your own analysis. And NEVER write an internal seat or role code such as "S0_2", "S0_3", or "P0" — those are matcher machinery; name the capability itself in plain words ("a qualitative research unit", not "a qualitative research unit (S0_2)").

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

// ── Seat-code scrubber (the client-boundary net) ────────────────────────────────────────────────
//
// The matcher labels the seats in a grant's ideal-applicant profile with internal codes — "P0"/"P1"
// for prime seats, "S0_1"/"S0_2" for the supporting seats beneath them (lib/grants/engine.ts,
// buildSeatMenu). Those labels ride inside the match's reasoning_context, which the QA pass hands the
// model, so a model writing the client-facing narrative (or a factor rationale) can echo them verbatim:
// "a qualitative research unit (S0_2), CCDF policy expertise (S0_3)…". They are pure internal machinery
// and must never reach a client — they read as leaked code to a staffer too (and the "0" reads as an "O").
//
// STRIP, NOT NULL. Dropping the whole narrative on a code (the narrativeGuard framing behaviour) would
// fall back to the engine paragraph, which is assembled from the SAME matcher rationale where the codes
// live — trading one coded field for another. So we remove the codes and keep the reasoning. Applied at
// every client-facing text boundary — the QA narrative (narrativeGuard here + resolveFit as a read net
// for already-stored narratives) and the factor rationales (viewFitFactors) — so no render path surfaces
// a code no matter which paragraph shows.
//
// THE WHOLE SEAT/PRIME-CODE FAMILY, UNCONDITIONALLY (Shannon, 2026-09-02). The matcher labels a grant's
// ideal-profile seats with a SUPPORTING code "S<n>_<m>" and a PRIME code "P<n>" (buildSeatMenu, engine.ts).
// BOTH are pure internal machinery and neither may ever reach rendered text — so this strips the whole
// `[SP]\d+(?:_\d*)*` family in every shape it can take: a prime "P0"/"P1", a full supporting "S0_1"/"S1_2",
// a trailing-underscore truncation from a generation cut mid-token "S0_"/"S1_", and a nested "S0_1_2",
// bare or parenthesised, glued to following text or not. This DELIBERATELY REVERSES the earlier
// P-preservation (Codex #480): the previous scope caught the underscore form but missed prime codes, so a
// "P0"/"P2" leaked. The known cost of stripping the whole P family is a COLLISION with legitimate
// client-facing identifiers that share the shape — an NIH activity code ("P30"/"P01") or a project phase
// ("P2") in real prose is removed too. Shannon accepted that trade for "no code of any form, ever": the
// codes are cosmetic-but-wrong, the collision is rare on GRANTED's roster, and the SOURCE-side scrub
// (scrubCardSeatCodes fed to the model prompt in intelContext) means the client narrative rarely contains a
// legitimate P-code to lose in the first place — this output strip is the backstop. "S.1234" (a bill) and
// "Section 8" are still safe: the strip requires a DIGIT immediately after S/P, which "S." and "Se" lack.
// Idempotent — a no-op on text with no codes.
//
// `[SP]\d+(?:_\d*)*` is the whole family in one sub-pattern: an S or P, one-or-more digits, then ZERO or
// more groups of (underscore + zero-or-more digits) — matching a bare "P0"/"S3", "S0_1", "S1_2", the
// trailing "S0_", and the nested "S0_1_2" alike.
export function stripSeatCodes(text: string): string {
  return text
    // A parenthetical that OPENS with a code — "(P0)", "(S0_2)", "(S0_6, e.g. town halls)", a truncated
    // "(S0_6, e." / "(S0_", or a nested "(S0_1_2)" — remove the whole group and its leading space.
    .replace(/\s*\(\s*[SP]\d+(?:_\d*)*[^)]*(?:\)|$)/g, "")
    // A bare code in prose ("…fills S0_2 and…", "P30", a dangling "S0_", a nested "S0_1_2").
    .replace(/\s*\b[SP]\d+(?:_\d*)*/g, "")
    // Tidy the seams the removals leave: an emptied "()", a space now before punctuation, doubled spaces.
    .replace(/\(\s*\)/g, "")
    .replace(/\s+([,.;:)])/g, "$1")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}

// Scrub the matcher's internal seat/role codes from EVERY free-text card field a detail page renders, in one
// pass at card-load. The codes live in the engine's prose — why_this_org, concept_synopsis,
// before_you_approve, the reasoning_context strings (which feed the IntellEngine Intel paragraph's
// lead/mitigation, the why-this-org bullets, the concept box and the score-derivation show-more) AND the
// per-factor rationales in factor_scores / qa_factor_scores (which a raw FactorBreakdown renders straight
// into a title + hover popover, bypassing viewFitFactors' own strip — Codex #485). Scrubbing the card once,
// at load, means NO downstream render can surface a code regardless of which field carried it. Returns a
// shallow clone (never mutates the input); idempotent; a field with no code comes back unchanged.
// reasoning_context is a flat string map, so a top-level value scrub covers it; it is typed `unknown` in
// the constraint (not Record<string, unknown>) so a page's concrete interface-typed reasoning_context still
// satisfies `T extends` — a declared interface is not assignable to an index-signature type ("missing index
// signature"), which would otherwise reject the call. It is narrowed to an object inside before scrubbing.
type SeatCodeCardText = {
  why_this_org?: string[] | null;
  concept_synopsis?: string | null;
  before_you_approve?: string[] | null;
  reasoning_context?: unknown;
  factor_scores?: FactorScores | null;
  qa_factor_scores?: FactorScores | null;
};
export function scrubCardSeatCodes<T extends SeatCodeCardText>(card: T): T {
  const arr = (a: string[] | null | undefined) =>
    Array.isArray(a) ? a.map((s) => (typeof s === "string" ? stripSeatCodes(s) : s)) : a;
  const str = (s: string | null | undefined) => (typeof s === "string" ? stripSeatCodes(s) : s);
  const rc = card.reasoning_context;
  const scrubbedRc =
    rc && typeof rc === "object" && !Array.isArray(rc)
      ? Object.fromEntries(
          Object.entries(rc as Record<string, unknown>).map(([k, v]) => [
            k,
            typeof v === "string" ? stripSeatCodes(v) : v,
          ]),
        )
      : rc;
  // Each of the 6 factors is { rating, rationale }; scrub the rationale string, keep everything else. Entry
  // iteration tolerates a partial / unexpected shape (a missing factor, a non-object value) without throwing.
  const factors = (f: FactorScores | null | undefined): FactorScores | null | undefined => {
    if (!f || typeof f !== "object") return f;
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(f)) {
      out[k] =
        v && typeof v === "object" && typeof (v as { rationale?: unknown }).rationale === "string"
          ? { ...(v as Record<string, unknown>), rationale: stripSeatCodes((v as { rationale: string }).rationale) }
          : v;
    }
    return out as unknown as FactorScores;
  };
  return {
    ...card,
    why_this_org: arr(card.why_this_org),
    concept_synopsis: str(card.concept_synopsis),
    before_you_approve: arr(card.before_you_approve),
    reasoning_context: scrubbedRc,
    factor_scores: factors(card.factor_scores),
    qa_factor_scores: factors(card.qa_factor_scores),
  } as T;
}

// Returns the narrative when it is present and clean; null when absent, empty, or it trips the framing
// scan. Null = "show the engine paragraph" (the fail-safe), never a partial/leaky client string. Seat
// codes are SCRUBBED (not a null trigger) after the framing scan passes — see stripSeatCodes.
export function narrativeGuard(raw: string | null | undefined): string | null {
  const text = (raw ?? "").trim();
  if (!text) return null;
  const haystack = text.toLowerCase();
  for (const marker of FORBIDDEN_NARRATIVE_MARKERS) {
    if (haystack.includes(marker)) return null;
  }
  const stripped = stripSeatCodes(text);
  return stripped || null;
}
