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

import type { Client, Grant, HardConstraint, ConstraintType } from "@/types/database";

const VALID_TYPES: ConstraintType[] = [
  "ineligible_funder",
  "role_ceiling",
  "ineligible_partner",
  "entity_screen",
];

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
  return raw.filter(
    (c): c is HardConstraint =>
      !!c &&
      typeof c === "object" &&
      VALID_TYPES.includes((c as HardConstraint).type) &&
      typeof (c as HardConstraint).value === "string" &&
      typeof (c as HardConstraint).note === "string",
  );
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

// Minimal shape the clamp mutates -- engine's MatchResult is structurally
// compatible. Kept local so this module imports no engine types (no cycle).
export interface ClampableMatch {
  proposed_role: string;
  recommended_prime: string | null;
  fit_score: 0 | 1 | 2 | 3;
  before_you_approve: string[];
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
    .map((c) => `- [${c.type}${c.scope ? ` · ${c.scope}` : ""}] ${c.note} (enforced in code: ${c.action})`)
    .join("\n");
}
