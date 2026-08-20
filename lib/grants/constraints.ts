// Hard, code-enforced client constraints.
//
// The "a miss is unacceptable" gates (legal / eligibility) that must NOT be left
// to the model as advisory matching_rules prose. Enforced deterministically in
// code, following the same shape as the seat-ceiling clamp: the model returns
// structured output, code overrides it. Precedence: hard_constraints supersede
// matching_rules supersede general logic.
//
// What code CAN enforce deterministically: structured fields (the proposed role,
// the recommended_prime, the funder). What it CANNOT: conditions that live in
// the NOFO text (entity_screen) or in free-text prose (a banned partner named
// inside the draft email) -- those become guaranteed before_you_approve flags,
// never silent excludes.

import type { Client, Grant, HardConstraint, ConstraintType, ConstraintAction } from "@/types/database";

const VALID_TYPES: ConstraintType[] = [
  "ineligible_funder",
  "role_ceiling",
  "ineligible_partner",
  "entity_screen",
  "do_not_surface_for",
];

// The ONLY valid role_ceiling values. A ceiling set to anything else ranks 99 in
// roleRank() below, so the clamp never fires -- a silently dead gate. The picker
// constrains this to a dropdown and validateConstraint rejects anything else.
export const ROLE_CEILING_VALUES = [
  "prime",
  "co-applicant",
  "sub",
  "named collaborator",
  "letter of support",
  "facilitator",
  "not recommended",
] as const;

// `action` is a deterministic function of `type` -- it describes what the code
// ALREADY does for that type, so it is derived here, never chosen by a human.
const ACTION_BY_TYPE: Record<ConstraintType, ConstraintAction> = {
  ineligible_funder: "exclude", // pre-model exclude (funderExclusionReason)
  role_ceiling: "cap_role", // post-model clamp
  ineligible_partner: "flag", // nulls recommended_prime + reviewer flag
  entity_screen: "flag", // reviewer flag only
  do_not_surface_for: "suppress", // post-model suppress on a contraindicated-topic match
};

export function deriveConstraintAction(type: ConstraintType): ConstraintAction {
  return ACTION_BY_TYPE[type];
}

export type ConstraintValidation =
  | { ok: true; constraint: HardConstraint }
  | { ok: false; error: string };

// Single source of truth for "is this a valid, enforceable constraint?" -- used
// by the picker (client), the server action (reject-on-save), and the read path
// (getClientConstraints). Normalizes: trims value/note, derives action from type,
// drops an empty scope. Fails CLOSED with a specific message so a human learns a
// gate is invalid at save time instead of discovering later it never fired.
export function validateConstraint(raw: unknown): ConstraintValidation {
  if (!raw || typeof raw !== "object") {
    return { ok: false, error: "constraint must be an object" };
  }
  const c = raw as Partial<HardConstraint>;
  if (!c.type || !VALID_TYPES.includes(c.type)) {
    return { ok: false, error: `unknown constraint type "${String(c.type)}"` };
  }
  const value = typeof c.value === "string" ? c.value.trim() : "";
  if (!value) return { ok: false, error: `${c.type}: a value is required` };
  const note = typeof c.note === "string" ? c.note.trim() : "";
  if (!note) {
    return { ok: false, error: `${c.type}: a note is required (shown to the reviewer and the model)` };
  }
  if (
    c.type === "role_ceiling" &&
    !(ROLE_CEILING_VALUES as readonly string[]).includes(norm(value))
  ) {
    return {
      ok: false,
      error: `role_ceiling value must be one of: ${ROLE_CEILING_VALUES.join(", ")} (got "${value}")`,
    };
  }
  // do_not_surface_for matches via topicTerms (comma-split, >= 3 chars). A value whose every term
  // is under 3 chars (e.g. "AI", "EV") tokenizes to nothing and would suppress nothing — a silently
  // dead gate, the same failure the role_ceiling enum check guards against. Reject it at save time.
  if (c.type === "do_not_surface_for" && topicTerms(value).length === 0) {
    return {
      ok: false,
      error: `do_not_surface_for: every term in "${value}" is under 3 characters and could never match — use a longer contraindicated topic term`,
    };
  }
  const scope = typeof c.scope === "string" && c.scope.trim() ? c.scope.trim() : undefined;
  const constraint: HardConstraint = {
    type: c.type,
    value,
    note,
    action: deriveConstraintAction(c.type),
    ...(scope ? { scope } : {}),
  };
  return { ok: true, constraint };
}

function norm(s: string | null | undefined): string {
  return (s ?? "").toLowerCase().replace(/\s+/g, " ").trim();
}

function includesNorm(haystack: string | null | undefined, needle: string): boolean {
  const n = norm(needle);
  return n.length > 0 && norm(haystack).includes(n);
}

// Validate the JSONB payload defensively -- malformed entries are dropped, never
// trusted. A bad constraint must not silently weaken enforcement OR crash scoring.
export function getClientConstraints(client: Pick<Client, "hard_constraints">): HardConstraint[] {
  const raw = client.hard_constraints;
  if (!Array.isArray(raw)) return [];
  // Read path stays fail-safe: invalid entries are dropped (never trusted, never
  // crash scoring). Reject-on-save keeps invalid entries from being stored in the
  // first place, but this is the last line of defense for legacy/hand-edited rows.
  const out: HardConstraint[] = [];
  for (const entry of raw) {
    const v = validateConstraint(entry);
    if (v.ok) out.push(v.constraint);
  }
  return out;
}

// PRE-MODEL: a client-specific ineligible funder excludes the grant before any
// model call. Deterministic. Returns a reason string (for the prefilter) or null.
export function funderExclusionReason(
  funder: string | null | undefined,
  client: Pick<Client, "hard_constraints" | "name">,
): string | null {
  for (const c of getClientConstraints(client)) {
    if (c.type === "ineligible_funder" && includesNorm(funder, c.value)) {
      return `Ineligible funder for ${client.name}: ${c.value}`;
    }
  }
  return null;
}

// Role-ceiling ranking. Higher = more involved recipient role. An unknown role
// ranks highest so an unexpected value is still clamped DOWN to the ceiling --
// fail toward enforcement, never accidentally permit a role above the cap.
const ROLE_RANK: Record<string, number> = {
  prime: 5,
  "co-applicant": 4,
  sub: 3,
  "named collaborator": 2,
  "letter of support": 1,
  facilitator: 1,
  "not recommended": 0,
};
function roleRank(role: string | null | undefined): number {
  const r = ROLE_RANK[norm(role)];
  return r === undefined ? 99 : r;
}

// Heuristic scope match for a scoped role_ceiling (e.g. UAMS partner-only on
// "research-heavy: R34, K12, PRIMED-AI"). The trigger condition lives in the
// grant, not in structured client data, so this is best-effort token matching,
// and a scoped ceiling always also emits a flag for the reviewer to verify.
function scopeMatches(scope: string, haystack: string): boolean {
  const tokens = norm(scope)
    .split(/[,\s]+/)
    .filter((t) => t.length >= 3);
  const h = norm(haystack);
  return tokens.some((t) => h.includes(t));
}

// A do_not_surface_for value is a COMMA-separated list of contraindicated topics, each a PHRASE.
// It must NOT reuse scopeMatches: that whitespace-OR tokenizer is fine for a low-stakes scoped
// role_ceiling (which also always flags for review), but full SUPPRESSION on a stray generic word
// is a silent over-drop. "crisis intervention services" is ONE phrase that must appear intact, not
// three tokens where "services" matches nearly every grant. Split on commas only; each term
// (>= 3 chars, so a dead all-short value is caught at validate time) matches as a substring; OR
// across terms so "crisis, forensic" still fires on a crisis grant OR a forensic grant.
function topicTerms(value: string): string[] {
  return norm(value)
    .split(",")
    .map((t) => t.trim())
    .filter((t) => t.length >= 3);
}
function topicMatches(value: string, haystack: string): boolean {
  const h = norm(haystack);
  // Word-boundary at the LEADING edge, not a raw substring: full suppression must not fire on a
  // mid-word collision ("art" inside "department"/"start"/"smart"). A leading \b still catches
  // trailing morphology ("forensic" → "forensically", "art" → "arts") while excluding the accidental
  // interior hits. (scopeMatches — the lower-stakes role_ceiling path that always ALSO flags — keeps
  // its substring heuristic; only this silent full-suppress path needs the tighter guard.)
  return topicTerms(value).some((term) => {
    const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(`\\b${escaped}`).test(h);
  });
}

// Minimal shape the clamp mutates -- engine's MatchResult is structurally
// compatible. Kept local so this module imports no engine types (no cycle).
export interface ClampableMatch {
  proposed_role: string;
  recommended_prime: string | null;
  fit_score: 0 | 1 | 2 | 3;
  before_you_approve: string[];
  // do_not_surface_for sets these. This is the FIRST code-set suppression — every other hard "no"
  // in the engine today is model-produced. A suppressed match does not card (pipeline's qualifies
  // gate), but the reason is recorded on the attempt and surfaced (with override) on manual-add —
  // never a silent drop, per this module's doctrine.
  suppressed: boolean;
  suppress_reason: string | null;
  // Model-produced fit-narrative. Optional here (a bare ClampableMatch may omit them; the engine's
  // MatchResult always carries them) so the do_not_surface_for scrub can NEUTRALIZE them at the
  // source — see the scrub in applyHardConstraints. A suppressed match must not carry positive
  // "why this fits" reasoning to ANY consumer (check-grant, a force-added card, the portal detail
  // page), because (a) it contradicts the suppression and (b) the confidential note was in-prompt,
  // so the model may have echoed it into these free-text fields.
  why_this_org?: string[] | null;
  concept_synopsis?: string | null;
  // `unknown` (not a Record) so the engine's concrete MatchResult interfaces stay assignable to
  // this param without an index-signature clash; the clamp only ASSIGNS these, never reads them.
  reasoning_context?: unknown;
  factor_scores?: unknown;
}

// POST-MODEL clamp. Mirrors the seat-ceiling clamp: code overrides the model's
// structured output for hard constraints. Mutates and returns the result.
export function applyHardConstraints(
  result: ClampableMatch,
  client: Pick<Client, "hard_constraints" | "name">,
  grant: Pick<Grant, "program_type" | "title" | "focus_areas" | "delivery_model" | "description">,
): ClampableMatch {
  const cons = getClientConstraints(client);
  if (cons.length === 0) return result;

  const haystack = [
    grant.program_type,
    grant.title,
    grant.delivery_model,
    grant.description,
    ...(grant.focus_areas || []),
  ]
    .filter(Boolean)
    .join(" ");

  for (const c of cons) {
    if (c.type === "role_ceiling") {
      const applies = !c.scope || scopeMatches(c.scope, haystack);
      if (applies && roleRank(result.proposed_role) > roleRank(c.value)) {
        const from = result.proposed_role;
        result.proposed_role = c.value;
        // A capped role cannot carry a prime-tier score.
        result.fit_score = Math.min(result.fit_score, 2) as 0 | 1 | 2 | 3;
        result.before_you_approve.unshift(
          `Role ceiling enforced for ${client.name}: capped from "${from}" to "${c.value}"${
            c.scope ? ` (scope: ${c.scope})` : ""
          }. ${c.note}`,
        );
      }
    } else if (c.type === "ineligible_partner") {
      // Deterministic on the structured prime field...
      if (includesNorm(result.recommended_prime, c.value)) {
        result.recommended_prime = null;
      }
      // ...but the org could still be named in the email/synopsis prose, which
      // code cannot excise. Specific, non-generic flag so the reviewer checks.
      result.before_you_approve.unshift(
        `BEFORE SENDING: verify "${c.value}" does not appear anywhere in the outreach email body or concept synopsis. ` +
          `${c.value} cannot be a recipient or subrecipient for ${client.name}; code blocks only the structured ` +
          `recommended-prime field, not the email prose. ${c.note}`,
      );
    } else if (c.type === "entity_screen") {
      result.before_you_approve.unshift(
        `ENTITY SCREEN (${c.value}): ${c.note} Confirm this grant does not conflict before approving.`,
      );
    } else if (c.type === "do_not_surface_for") {
      // Deterministic SUPPRESS when the grant's text matches a contraindicated topic (e.g. a
      // client exiting a service line). Best-effort token match on the grant haystack, same
      // heuristic as a scoped role_ceiling — so it ALWAYS records a reason and stays overridable
      // (the manual-add path surfaces a suppressed match with an override), never a silent drop.
      if (topicMatches(c.value, haystack)) {
        result.suppressed = true;
        // Preserve any prior reason — a Phase-0 structural suppression the model set, or an earlier
        // matching constraint — rather than clobbering it. match_attempts.suppress_reason is the sole
        // audit record; last-write-wins would erase a real structural disqualifier from the trail.
        const reason = `Do-not-surface for ${client.name} (${c.value}): ${c.note}`;
        result.suppress_reason = result.suppress_reason
          ? `${result.suppress_reason} | ${reason}`
          : reason;
        result.before_you_approve.unshift(
          `SUPPRESSED — contraindicated for ${client.name} (matched "${c.value}"): ${c.note} ` +
            `Override via manual add if this has changed.`,
        );
        // SCRUB the model's fit-narrative AT THE SOURCE. The model scored this as a fit not
        // knowing code would suppress it, so why_this_org / concept_synopsis / reasoning_context /
        // factor_scores carry positive "why this fits" prose — contradictory, and a possible echo
        // of the confidential note (it was in-prompt). Clearing them here cleans the match for
        // EVERY consumer at once: check-grant (both branches), a force-added override card, and
        // the portal grant-detail page that renders reasoning_context/factor_scores. Staff keep
        // the real reason (suppress_reason + the before_you_approve line above).
        result.why_this_org = [];
        result.concept_synopsis = null;
        result.factor_scores = null;
        result.reasoning_context = {
          fit_score_derivation: "Suppressed: contraindicated for this client (see before_you_approve).",
        };
      }
    }
    // ineligible_funder is enforced pre-model (funderExclusionReason); no clamp.
  }
  return result;
}

// For prompt injection: tell the model the code-enforced constraints so its
// output aligns with what the clamp will enforce. Authoritative like
// matching_rules, but these are ALSO enforced in code.
export function formatConstraintsForPrompt(client: Pick<Client, "hard_constraints">): string {
  const cons = getClientConstraints(client);
  if (cons.length === 0) return "None";
  return cons
    .map((c) => {
      if (c.type === "do_not_surface_for") {
        // Do NOT emit the confidential staff `note` into the model prompt — the model can echo or
        // paraphrase it into its free-text output (reasoning/why_this_org), which reaches the
        // client. Code suppresses this deterministically post-model, so the model only needs the
        // topic + a directive, never the strategy behind it. (The scrub above is the backstop; this
        // keeps the confidential text out of the model's mouth in the first place.)
        return `- [do_not_surface_for · ${c.value}] Treat "${c.value}" as a standing contraindication for this client — do NOT present it as a fit. (enforced in code: suppress)`;
      }
      return `- [${c.type}${c.scope ? ` · ${c.scope}` : ""}] ${c.note} (enforced in code: ${c.action})`;
    })
    .join("\n");
}
