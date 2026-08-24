// Generic-over-specific demotion tag.
//
// A card-SURFACING post-processor — NOT occupancy. It never flips a seat or changes fit_score; the
// only effect is a DEMOTE SORT KEY (generic_nexus_flagged) plus a lead before_you_approve flag. That
// is why it hooks at the card-surfacing seam in pipeline.ts alongside calibrateMatch, NOT in engine.ts
// with applyMissionGate / routeSupportingSeat (which do flip seats/scores). engine.ts is untouched.
//
// THE BUG (fix #6). An org matches a grant's BROAD theme but lacks the SPECIFIC qualifying dimension
// the grant gates on, and nothing in the client record confirms that specific nexus. The scorer seats
// it at a conditional 2 and ADMITS the gap in its own first-pass caveats: "inferred from mission
// alignment", "not confirmed as a current program area", "history in that specific context is
// unverified". The canonical case: NWACC surfaced on a reentry-EDUCATION grant because its
// applied/workforce mission matched the theme, despite no confirmed correctional-education history.
//
// THE DISCRIMINATOR (settled against the real seated-2 rows, not function-vs-artifact). A true
// generic-over-specific miss and a legitimate execution-conditional 2 BOTH emit a "no confirmed prior
// [specific] program" caveat and look near-identical on the surface (NWACC "no correctional programming"
// vs Columbia County "no existing BWC program"). Function-vs-artifact OVER-FIRES on the second. The line
// that actually separates them is one level deeper:
//   entailed_by_identity  — the grant's qualifying dimension is ENTAILED by the org's CONFIRMED
//                           structural identity; the gap is only execution (MOU, past-performance, SAM,
//                           budget). Columbia County IS a county law-enforcement agency → a body-worn-
//                           camera program is a new instance of a function its identity already entails.
//                           Arisa × MAT: "purpose alignment is strong (direct clinical SUD services)".
//                           → LEGITIMATE 2. Leave alone.
//   inferred_from_adjacency — the qualifying dimension is INFERRED from thematic adjacency to a broad
//                           theme the org does confirm; the org may not do this specific work at all.
//                           NWACC "history in that specific context is unverified"; Arisa × Family-SUD
//                           "justice-involved population not confirmed as a current program area".
//                           → the generic-over-specific error. Demote + flag.
//
// TWO LOCKED PROPERTIES (see generic-nexus.test.ts):
//   1. EXISTENCE TEST, not purity test. A row is a MIXTURE — NWACC's ONE nexus caveat sits beside four
//      execution caveats (MOU, no federal history, SAM, budget). The gate fires if the bundle CONTAINS
//      an inferred-nexus caveat, regardless of how many execution caveats surround it. The classifier
//      prompt says exactly this; the demote triggers on basis === "inferred_from_adjacency" alone.
//   2. ERR TOWARD SURFACING (under-flag, never over-flag). Demoting a genuine county/clinic match off
//      the surface is the more expensive error, so the middle band (county→jail, SUD→justice-involved)
//      leans entailed. The prompt instructs an entailed default when genuinely ambiguous, AND the
//      fail-safe (missing / unparseable / thrown) returns NO flag. Both paths err toward surfacing.
//
// ACTION is DEMOTE-WITHIN-2 + a lead flag, NOT suppress (deliberately conservative for launch, widen
// later — same discipline as calibration). Unlike the circular-inference geo drop (circular geo is
// NEVER a real signal → hard drop), an inferred nexus is sometimes a real-but-undocumented fit, so the
// card stays visible with the assumption flagged; console review catches the demoted-but-flagged ones.
//
// PROFILE-FREE (the #138→#140 discipline, by construction). The classifier decides whether the
// qualifying dimension is entailed by the org's CONFIRMED identity — so it reads the SAME raw client
// fields the occupancy pass uses (clientContextForJudge: org type, location, service area, funding
// needs, authoritative rules), NEVER client_profile. client_profile is the distilled/inferred narrative;
// feeding it here would literally undermine the "confirmed" anchor the whole judgment rests on.
//
// Flag: MATCH_GENERIC_NEXUS_GATE_ENABLED. OFF, or any guard failing, is IDENTITY: no flag, NO model
// call — so the card is byte-identical to today (generic_nexus_flagged written false = the column
// default). Revert is flip-off + redeploy (Vercel binds env at build), same as the other match flags.

import { getAnthropicClient, MODEL } from "@/lib/anthropic";
import { buildSeatMenu, type MatchResult } from "@/lib/grants/engine";
import { clientContextForJudge } from "@/lib/grants/subseat-routing";
import type { Client, Grant } from "@/types/database";

const FLAG = "MATCH_GENERIC_NEXUS_GATE_ENABLED";

// The scoped judgment: ONE question — is the grant's qualifying dimension entailed by the client's
// confirmed identity, or inferred from thematic adjacency? Nothing about eligibility, seat, or score.
export interface NexusJudgment {
  // The specific dimension THIS grant gates on, as the classifier reads it from the caveats
  // (e.g. "in-facility correctional education", "justice-involved population", "dementia caseload").
  qualifying_dimension: string;
  basis: "entailed_by_identity" | "inferred_from_adjacency";
  rationale: string;
}

// The card-surfacing effect of a judgment. Pure; the pipeline consumes { flagged, note }.
export interface NexusFlag {
  flagged: boolean;
  note: string | null; // the lead before_you_approve item, only when flagged
}

const IDENTITY: NexusFlag = { flagged: false, note: null };

// Demote-within-2 only. fit_score 3 is clean-and-strong by definition (no caveat to classify); a score
// below 2 does not surface at all. Suppressed / disqualified are hard-gated elsewhere and never carded.
// Exported for deterministic unit testing. Flag OFF short-circuits FIRST — OFF makes no model call.
export function isNexusCandidate(result: MatchResult): boolean {
  if (process.env[FLAG] !== "true") return false; // flag gate — OFF is byte-identical to today
  if (result.suppressed || result.disqualified) return false;
  if (result.fit_score !== 2) return false; // demote is WITHIN the conditional-2 tier only
  const seated = !!result.seat_ref && result.seat_ref !== "NONE";
  if (!seated) return false;
  return true;
}

// Pure: turn a judgment into the card effect. The EXISTENCE TEST lives here — a single
// "inferred_from_adjacency" basis flags, regardless of the execution caveats beside it. Exported so a
// unit test proves it with a FAKED judgment (no model call), the same discipline as applySeatJudgment.
export function nexusFlagFromJudgment(j: NexusJudgment): NexusFlag {
  if (j.basis !== "inferred_from_adjacency") return IDENTITY;
  const dim = j.qualifying_dimension?.trim() || "the specific qualifying dimension";
  return {
    flagged: true,
    note:
      `GENERIC-OVER-SPECIFIC — the qualifying dimension (${dim}) is inferred from thematic adjacency, ` +
      `not confirmed in the client record. Confirm this specific nexus before surfacing.`,
  };
}

const NEXUS_JUDGE_SYSTEM_PROMPT = `You are checking EXACTLY ONE thing: for THIS grant's specific qualifying dimension, do the first-pass caveats show that dimension is ENTAILED by the client's CONFIRMED identity, or INFERRED from thematic adjacency?

You are NOT deciding eligibility, seat, score, past performance, or whether the grant should surface. Ignore all of that. Answer only the entailed-vs-inferred question about the ONE dimension the grant gates on.

Definitions:
- QUALIFYING DIMENSION = the specific population, setting, or program type this grant requires (e.g. an in-facility correctional setting, a justice-involved population, a dementia caseload, a body-worn-camera program). Read it from the caveats — they name it.
- entailed_by_identity = the client's CONFIRMED structural identity already entails performing that kind of work; the caveat is about an EXECUTION artifact for work the org demonstrably does — a signed MOU, past-performance / federal-grant history, SAM registration, budget/cash-flow, a not-yet-named partner, or simply "no prior INSTANCE of this program" for a function the org's type intrinsically performs. Example: a county sheriff's office with "no existing body-worn-camera program" — policing is confirmed; the BWC program is a new instance. A SUD clinic with "no federal grant history" on an opioid-treatment grant — the SUD function is confirmed; the gap is past performance.
- inferred_from_adjacency = the qualifying dimension is INFERRED from the org's adjacency to a BROADER theme it confirms, and the org may not do that specific work at all. The caveat says the dimension itself is "inferred from mission alignment", "not confirmed as a current program area", "history in that specific context is unverified", "assumed based on [a broad service model]". Example: a community college with an applied/workforce mission but "no confirmed prior programming inside a correctional facility". A behavioral-health nonprofit whose "capacity to serve justice-involved populations specifically is inferred from its SUD service model — not confirmed as a current program area".

Rules:
- EXISTENCE TEST, not a purity test. A caveat bundle is normally a MIXTURE — a single inferred-nexus caveat can sit beside several ordinary execution caveats (MOU, past-performance, SAM, budget). If ANY ONE caveat says the grant's specific qualifying dimension is inferred / assumed / "not confirmed as a current program area" / "history in that specific context is unverified", the basis is inferred_from_adjacency — no matter how many execution caveats surround it. Do NOT average or vote; one genuine inferred-dimension caveat decides it.
- Execution caveats ALONE never make it inferred. MOU-not-signed, no-federal-history, SAM-expiring, budget-unknown, partner-not-named — for a function the org's confirmed type performs — are entailed_by_identity. These are the legitimate conditional-2s; leave them.
- BIAS TOWARD entailed_by_identity WHEN GENUINELY AMBIGUOUS. When it is a close call whether the dimension is entailed by the org's confirmed identity or inferred from adjacency — especially near-structural roles (a county government "assumed to operate a detention facility"; a SUD provider whose justice-involved caseload "exists but is unverified") — default to entailed_by_identity. Under-flagging a real match is the CHEAPER error; demoting a genuine county or clinic match off the surface is more expensive than leaving a possibly-generic one up. Only return inferred_from_adjacency when a caveat plainly states the specific dimension is inferred/assumed/unconfirmed-as-current.
- Decide from the client's CONFIRMED identity (entity type, location, service area, funding needs, authoritative rules) and the first-pass caveats. Do not use any distilled narrative or assumed capability.
- Return the answer via the submit_nexus_judgment tool exactly once.`;

async function judgeNexus(result: MatchResult, grant: Grant, client: Client): Promise<NexusJudgment> {
  const anthropic = getAnthropicClient();
  const { menu } = buildSeatMenu(grant.ideal_applicant_profile ?? null);
  const rc = result.reasoning_context ?? null;
  const caveats =
    `before_you_approve:\n${(result.before_you_approve ?? []).map((s) => `  - ${s}`).join("\n") || "  (none)"}\n\n` +
    `inferred_fields:\n${(result.inferred_fields ?? []).map((s) => `  - ${s}`).join("\n") || "  (none)"}\n\n` +
    `fit_score_derivation:\n${rc?.fit_score_derivation?.trim() || "(none)"}\n\n` +
    `eligibility_analysis:\n${rc?.eligibility_analysis?.trim() || "(none)"}`;

  const response = await anthropic.messages.create({
    model: MODEL,
    max_tokens: 1000,
    temperature: 0,
    system: NEXUS_JUDGE_SYSTEM_PROMPT,
    tools: [
      {
        name: "submit_nexus_judgment",
        description: "Return the single entailed-vs-inferred judgment. Call exactly once.",
        input_schema: {
          type: "object",
          properties: {
            qualifying_dimension: { type: "string" },
            basis: { type: "string", enum: ["entailed_by_identity", "inferred_from_adjacency"] },
            rationale: { type: "string" },
          },
          required: ["qualifying_dimension", "basis", "rationale"],
        },
      },
    ],
    tool_choice: { type: "tool", name: "submit_nexus_judgment" },
    messages: [
      {
        role: "user",
        content:
          `GRANT: ${grant.title}\n\n` +
          `SEAT MENU (the client occupies ${result.seat_ref}; use this to understand the grant's target roles):\n${menu}\n\n` +
          `FIRST-PASS CAVEATS (classify the qualifying dimension named here):\n${caveats}\n\n` +
          `CLIENT (confirmed identity only):\n${clientContextForJudge(client)}`,
      },
    ],
  });

  const toolUse = response.content.find((b) => b.type === "tool_use");
  if (!toolUse || toolUse.type !== "tool_use") {
    // Fail SAFE toward SURFACING: a missing judgment must NOT flag. Treat as entailed (no demote).
    return {
      qualifying_dimension: "",
      basis: "entailed_by_identity",
      rationale: "scoped nexus judgment returned no structured output",
    };
  }
  return toolUse.input as NexusJudgment;
}

// Entry point, called once from scoreGrantClientPair AFTER calibration, only for surfacing matches.
// Identity — and crucially NO model call — unless every candidate guard passes. On any thrown error
// (rate limit, network, API 5xx) it FALLS BACK to no-flag: this pair simply is not demoted, identical
// to flag-OFF for it, and the card still surfaces (the under-flag bias again). Logged LOUD so a
// swallowed failure that silently stops flagging on a live client is visible, never silent.
export async function evaluateGenericNexus(
  result: MatchResult,
  client: Client,
  grant: Grant,
): Promise<NexusFlag> {
  if (!isNexusCandidate(result)) return IDENTITY;
  try {
    const j = await judgeNexus(result, grant, client);
    return nexusFlagFromJudgment(j);
  } catch (err) {
    console.error(
      `[evaluateGenericNexus] scoped nexus judgment FAILED for client ${client.name} on grant ${grant.id}; ` +
        `NOT flagging (card still surfaces): ${err instanceof Error ? err.message : String(err)}`,
    );
    return IDENTITY;
  }
}
