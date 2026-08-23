// Code-side supporting-seat routing.
//
// This REPLACES the prompt-only SUBSEAT_ROUTING_ADDENDUM that used to be appended to
// MATCHING_SYSTEM_PROMPT. The model would not reliably obey that prose: the model-in-the-loop eval
// (subseat-routing.eval.test.ts) showed it inventing a "no identified prime => not actionable => NONE"
// requirement that directly contradicts the base SUPPORTING-SEAT FLOOR, and doing so inconsistently
// run-to-run. Routing that the model won't reliably perform belongs in code, not in the prompt.
//
// The mechanism: when the FIRST (full) scoring pass disqualifies / NONEs a SUB-CAPABLE entity on a
// SUB-PERMITTING, NON-SUPPRESSED grant, a NARROW second model call — scoped to the single question
// "does this client genuinely fill a listed supporting seat's named function?", isolated from the
// disqualify reflex — decides occupancy, and this module then routes IN CODE. The DEFER-FIRST
// conditions that were prompt prose are now deterministic guards here.
//
// Reuses the same flag as the old addendum, MATCH_SUBSEAT_ROUTING_ENABLED. Flag OFF, or any guard
// failing, is IDENTITY: no mutation and NO second model call, so matchGrantToClient's output is
// byte-identical to today's flag-OFF behavior.
//
// IMPORTANT (build note, human-review gate): the unit tests fake the SeatJudgment, so they prove the
// PLUMBING (guards + mutation), NOT that the scoped call's judgments are correct. The scoped prompt
// is the load-bearing part; its real quality must be confirmed by human review of its outputs on
// representative prime-ineligible-specialist pairs before the flag is flipped. And `defers_to_client_rule`
// is itself a model judgment, so the "never override a legitimate client rule" guarantee is only as
// good as that judgment — the prompt is emphatic about deferring, and the review set must include a
// case WITH a client rule (e.g. Arisa / supplanting) to confirm it actually defers.

import { getAnthropicClient, MODEL } from "@/lib/anthropic";
import { buildSeatMenu } from "@/lib/grants/engine";
import type { MatchResult } from "@/lib/grants/engine";
import type { Client, Grant } from "@/types/database";

const FLAG = "MATCH_SUBSEAT_ROUTING_ENABLED";

// Sub-capable = an entity type that CAN be a funded subrecipient / co-applicant. Nonprofits yes;
// for-profit and federal agencies NO (the HARD ROLE RULES own those). Deterministic, not model-judged.
function isSubCapable(orgType: string | null | undefined): boolean {
  const t = (orgType ?? "").toLowerCase();
  if (!t) return false;
  if (t.includes("for-profit") || t.includes("for profit") || t.includes("commercial")) return false;
  if (t.includes("federal")) return false; // federal agency -> Named Collaborator only
  return true; // nonprofit and other civilian entity types can sub
}

// The DEFER-FIRST conditions, now CODE guards (was prompt prose the model ignored). Routing may be
// CONSIDERED only when every one holds; otherwise this is a strict identity (no second call).
// Exported for deterministic unit testing.
export function isRoutingCandidate(result: MatchResult, client: Client, grant: Grant): boolean {
  if (process.env[FLAG] !== "true") return false; // flag gate — OFF is byte-identical to today
  if (result.suppressed) return false; // suppression is never touched here
  if (grant.subaward_prohibited === true) return false; // no sub/co-applicant structure
  if (!isSubCapable(client.org_type)) return false; // for-profit / federal -> HARD ROLE RULES
  // Only act when the first pass did NOT already seat the client. seat_ref is a string with the
  // sentinel "NONE"; treat null/empty defensively as unseated too.
  const seated = !!result.seat_ref && result.seat_ref !== "NONE";
  if (!result.disqualified && seated) return false;
  const { seats } = buildSeatMenu(grant.ideal_applicant_profile ?? null);
  const hasSupporting = Array.from(seats.values()).some((t) => t === "partner");
  if (!hasSupporting) return false; // no supporting seat to route to
  return true;
}

// The scoped second judgment: ONE question — does the client genuinely perform a listed supporting
// seat's named function? NOT eligibility, NOT prime fit, NOT whether to surface. Isolated from the
// disqualify reflex that swamped the addendum. matching_rules ARE provided and the prompt DEFERS to a
// genuine self-suppress / avoid rule (a legitimate client decline stands, e.g. supplanting).
export interface SeatJudgment {
  fills: boolean; // does the client genuinely fill a specific listed supporting seat?
  seat_ref: string | null; // the S{i}_{j} id, when fills
  seat_function: string | null; // the named function the client performs in that seat
  prime_type: string | null; // eligible prime entity TYPE the client would sub under
  defers_to_client_rule: boolean; // a client matching rule legitimately declines this pursuit
  // Sub-routing may ONLY reverse a prime-ENTITY-ineligibility disqualification. This flag is the
  // judge's reading of the FIRST-pass disqualify reason: true ONLY when prime-entity-ineligibility is
  // the SOLE barrier. Any OTHER contributing reason (geography, a capital-only / supplanting client
  // rule, a mission/purpose mismatch, past-performance, etc.) — alone or in addition to prime-
  // ineligibility (Harbor House's dual disqualification) — makes it false, and the routing defers.
  // A model judgment, not a regex over the reason string: the whole bug class this guards (the #409
  // misfiring regex, the #408 reason-blindness) exists because free-text reasons don't classify
  // cleanly with regex, so the check reads the reason IN CONTEXT rather than pattern-matching it.
  disqualification_is_prime_ineligibility_only: boolean;
  rationale: string;
}

const SEAT_JUDGE_SYSTEM_PROMPT = `You are checking EXACTLY ONE thing and nothing else: does this client GENUINELY perform a specific listed SUPPORTING seat's named function in this grant's consortium?

You are NOT deciding eligibility, prime fit, award size, past performance, or whether the grant should ultimately surface. Ignore all of that. Answer only the seat-occupancy question.

Rules:
- "fills" = true ONLY if the client performs a SPECIFIC listed supporting seat's named function — you must name the exact S{i}_{j} id AND the function. Generic "delivery"/"support"/topical adjacency is NOT filling a seat: fills = false.
- A missing or unnamed prime is NOT a reason to answer false. Supporting seats exist independently of whether a specific prime has been identified. Do not require a named prime.
- recommended prime: give the eligible prime entity TYPE the client would sub under (e.g. "county government", "state agency"); name a specific organization only if one is genuinely obvious.
- DEFER TO CLIENT RULES: if the client's authoritative matching rules or known constraints give a genuine strategic reason to AVOID this pursuit (e.g. a supplanting / fund-replacement restriction, a "do not fund existing staff/roles" rule, an explicit self-suppression), set defers_to_client_rule = true. This is respected absolutely: a legitimate client rule declining the grant is correct and must not be overridden, even when the seat is genuinely filled. When in doubt about whether a rule applies, prefer defers_to_client_rule = true.
- SOLE-BARRIER CHECK (disqualification_is_prime_ineligibility_only): you are shown the FIRST-pass DISQUALIFY REASON that removed this client. Sub-routing is allowed to reverse ONE thing only — a disqualification whose SOLE barrier is that the client is the wrong ENTITY TYPE to be the PRIME/direct applicant (e.g. "nonprofit excluded, government-only NOFO"). Set disqualification_is_prime_ineligibility_only = true ONLY when prime-entity-ineligibility is the ONLY reason the client was removed. Set it FALSE whenever ANY other reason contributes — even if prime-ineligibility is ALSO present:
  · geography / service-area restriction ("does not serve the eligible region"),
  · a client matching rule or known constraint (e.g. capital-only, supplanting, program-type restriction — note this typically ALSO sets defers_to_client_rule),
  · a mission / purpose / programmatic mismatch (the client does not do this kind of work),
  · past-performance, capacity, award-size, or any other substantive barrier.
  A DUAL disqualification (prime-ineligibility PLUS any of the above) is FALSE — routing must not resurrect a client that a second, independent barrier also removed. If the reason is empty, vague, or you are unsure whether a non-prime barrier is present, set it FALSE (fail safe: do not route).
- Return the answer via the submit_seat_judgment tool exactly once.`;

function clientContextForJudge(client: Client): string {
  const profile = (client.client_profile ?? null) as Record<string, unknown> | null;
  const pick = (key: string): string => {
    const v = profile?.[key];
    if (v == null) return "";
    return typeof v === "string" ? v : JSON.stringify(v);
  };
  const lines = [
    `Client: ${client.name}`,
    `Entity type: ${client.org_type ?? "unknown"}`,
    profile ? `Mission: ${pick("mission")}` : "",
    profile ? `Core capabilities: ${pick("core_capabilities")}` : "",
    profile ? `Supporting roles it can play: ${pick("supporting_roles")}` : "",
    `Authoritative matching rules (defer to these): ${client.matching_rules ?? "none"}`,
    `Known constraints (defer to these): ${client.known_constraints ?? "none"}`,
  ];
  return lines.filter(Boolean).join("\n");
}

async function judgeSupportingSeat(
  client: Client,
  grant: Grant,
  disqualifyReason: string | null | undefined,
): Promise<SeatJudgment> {
  const anthropic = getAnthropicClient();
  const { menu } = buildSeatMenu(grant.ideal_applicant_profile ?? null);
  const response = await anthropic.messages.create({
    model: MODEL,
    max_tokens: 1500,
    temperature: 0,
    system: SEAT_JUDGE_SYSTEM_PROMPT,
    tools: [
      {
        name: "submit_seat_judgment",
        description: "Return the single seat-occupancy judgment. Call exactly once.",
        input_schema: {
          type: "object",
          properties: {
            fills: { type: "boolean" },
            seat_ref: { type: ["string", "null"] },
            seat_function: { type: ["string", "null"] },
            prime_type: { type: ["string", "null"] },
            defers_to_client_rule: { type: "boolean" },
            disqualification_is_prime_ineligibility_only: { type: "boolean" },
            rationale: { type: "string" },
          },
          required: [
            "fills",
            "seat_ref",
            "seat_function",
            "prime_type",
            "defers_to_client_rule",
            "disqualification_is_prime_ineligibility_only",
            "rationale",
          ],
        },
      },
    ],
    tool_choice: { type: "tool", name: "submit_seat_judgment" },
    messages: [
      {
        role: "user",
        content:
          `GRANT: ${grant.title}\n\n` +
          `FIRST-PASS DISQUALIFY REASON (for the sole-barrier check — was prime-entity-ineligibility the ONLY reason?):\n` +
          `${disqualifyReason?.trim() || "(none recorded)"}\n\n` +
          `SUPPORTING SEAT MENU (choose only from these S{i}_{j} ids):\n${menu}\n\n` +
          `CLIENT:\n${clientContextForJudge(client)}`,
      },
    ],
  });

  const toolUse = response.content.find((b) => b.type === "tool_use");
  if (!toolUse || toolUse.type !== "tool_use") {
    // Fail SAFE: a missing judgment must not route. Treat as "does not fill" AND not a clean
    // prime-ineligibility (either alone blocks the route in applySeatJudgment).
    return {
      fills: false,
      seat_ref: null,
      seat_function: null,
      prime_type: null,
      defers_to_client_rule: false,
      disqualification_is_prime_ineligibility_only: false,
      rationale: "scoped seat judgment returned no structured output",
    };
  }
  return toolUse.input as SeatJudgment;
}

// The deterministic mutation the prompt could not reliably make, given a seat judgment. Pure and
// exported so unit tests can prove the plumbing with a FAKED judgment (no model call). Routes ONLY on
// a genuine seat with a named id, and NEVER over a legitimate client-rule decline. Supporting-seat
// floor: partner seat (code ceiling caps it at 2), the missing prime is a FLAG not a disqualifier,
// and `suppressed` is left EXACTLY as prior code set it.
export function applySeatJudgment(result: MatchResult, client: Client, grant: Grant, j: SeatJudgment): void {
  if (!j.fills || j.defers_to_client_rule || !j.seat_ref || j.seat_ref === "NONE") return;
  // SOLE-BARRIER GATE (the #408 disqualify-reason-blind fix): sub-routing may reverse ONLY a
  // prime-ENTITY-ineligibility disqualification. If any other barrier contributed (geography, a
  // capital-only / supplanting client rule, a mission mismatch, …) — even alongside prime-
  // ineligibility (a DUAL disqualification like Harbor House) — the judge sets this false and we do
  // NOT route: a second, independent barrier must not be resurrected into a Sub seat. Fail-safe: the
  // no-structured-output fallback returns false here, so a missing judgment never routes.
  if (!j.disqualification_is_prime_ineligibility_only) return;
  // Validate the seat against THIS grant's menu: the model must have named a real SUPPORTING (partner)
  // seat. A prime id (P{i}), or a hallucinated / non-existent id, is not a sub routing — bail to
  // identity. The supporting-seat floor and the "sub, fit 2" mutation only make sense for a partner seat.
  const { seats } = buildSeatMenu(grant.ideal_applicant_profile ?? null);
  if (seats.get(j.seat_ref) !== "partner") return;
  result.seat_ref = j.seat_ref;
  result.proposed_role = "Sub";
  result.fit_score = 2;
  result.disqualified = false;
  result.recommended_prime = j.prime_type;
  result.before_you_approve = [
    `Prime applicant needed — ${client.name} subs under ${j.prime_type ?? "an eligible prime entity type"}.`,
    ...(result.before_you_approve ?? []),
  ];
  // Explainable, never silent (mirrors the calibration note). Prepend so the routing rationale leads.
  result.reasoning_context = {
    ...(result.reasoning_context ?? {}),
    fit_score_derivation:
      `Supporting-seat routing → ${j.seat_ref} (${j.seat_function ?? "listed supporting seat"}): ` +
      `prime-ineligible entity routed to Sub (floor 2), prime gap flagged. ` +
      (result.reasoning_context?.fit_score_derivation ?? ""),
  };
}

// Entry point, called once from matchGrantToClient after the seat clamp + applyHardConstraints.
// Mutates `result` IN PLACE and returns void. Identity — and crucially NO second model call —
// unless every guard passes. The composition is: guards -> scoped judgment -> code mutation.
export async function routeSupportingSeat(
  result: MatchResult,
  client: Client,
  grant: Grant,
): Promise<void> {
  if (!isRoutingCandidate(result, client, grant)) return;
  // Resilience: the scoped second model call is the ONLY thing here that can throw (rate limit,
  // network, API 5xx). On failure, FALL BACK to the pre-sub-routing result -- because we only mutate
  // `result` inside applySeatJudgment, catching before it runs leaves `result` EXACTLY as the first
  // (full) pass computed it: this one pair simply is not sub-routed, identical to flag-OFF for it, and
  // harmless. NEVER rethrow -- without this, the error propagates out of matchGrantToClient and
  // scoreGrantClientPair discards the entire already-valid match as outcome='error'. Log LOUD and
  // greppable: a swallowed failure that silently stops sub-routing on a live client is the real risk
  // (it would undo the fix with no signal), so the failure must be VISIBLE, never silent.
  try {
    const j = await judgeSupportingSeat(client, grant, result.disqualify_reason);
    applySeatJudgment(result, client, grant, j);
  } catch (err) {
    console.error(
      `[routeSupportingSeat] scoped seat judgment FAILED for client ${client.name} on grant ${grant.id}; ` +
        `falling back to the un-routed result (this pair is not sub-routed): ` +
        `${err instanceof Error ? err.message : String(err)}`,
    );
  }
}
