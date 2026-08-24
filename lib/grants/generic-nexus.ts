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
//      a genuine inferred-nexus caveat, regardless of how many execution caveats surround it. The
//      demote triggers on basis === "inferred_from_adjacency" alone.
//   2. ERR TOWARD SURFACING (under-flag, never over-flag). Demoting a genuine county/clinic match off
//      the surface is the more expensive error, so the middle band (county→jail, SUD→justice-involved)
//      leans entailed. The prompt instructs an entailed default when genuinely ambiguous, AND the
//      fail-safe (missing / unparseable / thrown) returns NO flag. Both paths err toward surfacing.
//
// EVAL-DRIVEN TIGHTENING (first eval run: FLAG band passed every run; two boundary over-flags fixed).
// The execution-vs-nexus line was leaking — Arisa×MAT (a clean SUD keep, only past-performance/
// sub-capability caveats) flagged 1/3, and Faulkner×jail (county assumed to run a jail) flagged 2/3.
// Three reinforcements, all in service of the two properties above:
//   (a) EXHAUSTIVE execution non-trigger list in the prompt — past-performance, MOU, SAM, budget,
//       licensure/credential-pending, key-personnel, AND a sub-capability within a CONFIRMED function
//       (buprenorphine-prescribing for a confirmed SUD provider). These can NEVER trip the flag, even
//       worded "inferred/unconfirmed": what is unconfirmed decides it (an execution attribute → entailed;
//       the qualifying FUNCTION/POPULATION itself → inferred), not the presence of the word.
//   (b) STRUCTURAL ENTAILMENT default — an entity-type-typical function (county→jail, sheriff→policing)
//       is entailed even when the instance is "assumed / not explicitly confirmed"; a documentation gap
//       is not a nexus gap. This is the heavy bias the near-structural middle band needs.
//   (c) CONCRETENESS GUARD — an inferred verdict must QUOTE the nexus caveat (triggering_caveat); a flag
//       with no cited evidence is dropped to no-flag (nexusFlagFromJudgment). This is the code-side
//       anti-leak backstop for when the prompt still wavers, and it robustifies against the run-to-run
//       occupancy/seat variation that feeds the classifier different caveats each pass — the decision
//       anchors on org identity + a quotable function/population caveat, not the (unstable) seat.
// ROUND 2 (eval run 2: MAT fixed, Faulkner 2/3→1/3, but the (a) sub-capability clause over-reached and
// under-flagged Arisa×Family-SUD 2/3 — a REAL generic-over-specific case it had flagged 3/3 in round 1).
// Two carve-backs: a DISTINCT POPULATION / PROGRAM AREA is NEVER a "sub-capability" — a technique/
// modality/credential is (buprenorphine), but "justice-involved population inferred, not a confirmed
// program area" is a genuine nexus trigger even for a confirmed SUD provider; and structural entailment
// is spelled out for a county's jail/detention FACILITY ("jurisdiction not confirmed" = documentation,
// not a nexus gap) to settle the Faulkner flicker.
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
  // CONCRETENESS GUARD: when basis is inferred_from_adjacency, the VERBATIM caveat that states the org
  // may not perform the qualifying FUNCTION / serve the qualifying POPULATION at all. Empty for
  // entailed_by_identity. A flag with no cited nexus caveat is not trustworthy (it's the leak that let
  // an execution caveat trip the flag), so nexusFlagFromJudgment drops a flag whose evidence is blank.
  triggering_caveat: string | null;
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
  // CONCRETENESS GUARD (anti-leak): an inferred verdict must cite the actual nexus caveat. A flag with
  // no quoted evidence is the failure mode where an execution/credential caveat vaguely reads as a
  // nexus gap — drop it and let the card surface. Errs toward surfacing, like every other fail path.
  if (!j.triggering_caveat?.trim()) return IDENTITY;
  const dim = j.qualifying_dimension?.trim() || "the specific qualifying dimension";
  return {
    flagged: true,
    note:
      `GENERIC-OVER-SPECIFIC — the qualifying dimension (${dim}) is inferred from thematic adjacency, ` +
      `not confirmed in the client record. Confirm this specific nexus before surfacing.`,
  };
}

const NEXUS_JUDGE_SYSTEM_PROMPT = `You are checking EXACTLY ONE thing: does the org perform the grant's specific QUALIFYING FUNCTION / serve its QUALIFYING POPULATION at all, or is that inferred only from the org's adjacency to a broader theme?

You are NOT deciding eligibility, seat, role, score, or whether the grant should surface. Ignore all of that. The client's seat/role (prime or sub) is IRRELEVANT to this question — decide from the org's CONFIRMED IDENTITY and the caveats about the qualifying function/population, never from the seat.

QUALIFYING DIMENSION = the specific population, setting, or program the grant gates on (e.g. an in-facility correctional setting, a justice-involved population, a dementia caseload, a body-worn-camera program). Name it from the caveats.

THE ONLY TRIGGER (inferred_from_adjacency): a caveat stating the org may not perform the qualifying FUNCTION, or serve the qualifying POPULATION, AT ALL — because that function/population is inferred from the org's adjacency to a BROADER theme it confirms. It reads like "inferred from mission alignment", "not confirmed as a current program area", "history in that specific context is unverified", "assumed based on [a broad service model]", "may not do this specific kind of work". Examples: a community college (applied/workforce mission) with "no confirmed prior programming inside a correctional facility"; a behavioral-health nonprofit whose "capacity to serve justice-involved populations is inferred from its SUD service model — not confirmed as a current program area"; a health agency whose "dementia caseload is inferred from its developmental-disability scope, not confirmed".

NOT A TRIGGER — EXECUTION CAVEATS (these are entailed_by_identity, ALWAYS, no matter how they are worded): the org's confirmed identity performs this kind of work; the caveat is about a deliverable, credential, record, or capacity for that work, NOT about whether it does the work. This list is EXHAUSTIVE of the non-triggers and OVERRIDES any surface wording:
  - past performance / no federal (or DOJ/BJA) grant history / no prior award;
  - MOU / partner / letter-of-commitment / subrecipient not yet named or signed;
  - SAM.gov / UEI / registration lapse or expiry;
  - budget / cash-flow / match / cost-share / financial-capacity;
  - licensure / certification / accreditation not yet documented (the CREDENTIAL for work the org does);
  - key-personnel / staffing / bandwidth / capacity;
  - award size;
  - a SUB-CAPABILITY WITHIN A CONFIRMED FUNCTION — a specific TECHNIQUE, MODALITY, CREDENTIAL, or technical capability inside a function the org confirms (e.g. buprenorphine-prescribing or a named tracking technology for a confirmed SUD/behavioral-health provider; a specific investigative technique for a confirmed law-enforcement agency). The FUNCTION is confirmed; the sub-capability is execution, NOT nexus.
A SUB-CAPABILITY IS A TECHNIQUE / MODALITY / CREDENTIAL — NEVER A DISTINCT POPULATION OR PROGRAM AREA. Serving a distinct qualifying POPULATION the grant gates on (justice-involved people, a dementia caseload, a homeless population) is NOT a sub-capability. If the org's service to that specific population is INFERRED from a broader service model and "not confirmed as a current program area" / "not confirmed as a current service area", that IS a genuine NEXUS trigger, not execution — even for an org whose broader function (e.g. SUD/behavioral-health treatment) is confirmed. Concretely: a behavioral-health SUD provider whose "capacity to serve JUSTICE-INVOLVED populations is inferred from its SUD service model, not confirmed as a current program area" → inferred_from_adjacency (the POPULATION is the gap); but buprenorphine-prescribing for that same confirmed SUD provider → entailed (a modality, not a population). Do not collapse a population/program-area gap into "a sub-capability of a confirmed function".
CRITICAL: the words "inferred", "assumed", "unconfirmed", "unverified", "not documented" appear on BOTH execution and nexus caveats. They do NOT decide it. What decides it is WHAT is unconfirmed: an EXECUTION ATTRIBUTE (history, paperwork, credential, capacity, a technique/modality) → entailed; the QUALIFYING FUNCTION, SETTING, or POPULATION ITSELF → inferred. If the org's confirmed identity performs the broad function AND serves the qualifying population, and only a record/credential/technique is unconfirmed, it is entailed — full stop.

STRUCTURAL ENTAILMENT (heavy default): when the qualifying function, SETTING, or facility is one the org's ENTITY TYPE structurally or typically operates, treat it as entailed_by_identity EVEN IF a caveat says the specific instance is "assumed", "not explicitly confirmed", or "jurisdiction not confirmed". This is a DOCUMENTATION gap, never a nexus gap — do NOT flag it. Canonical entailed cases (flag NONE of these):
  - a COUNTY GOVERNMENT "assumed to operate or have jurisdiction over a jail / detention / confinement facility — not explicitly confirmed" → entailed. Operating and having jurisdiction over detention/confinement facilities is a core, structural county-government function; an unconfirmed instance is documentation, not a missing nexus.
  - a SHERIFF'S OFFICE / county law-enforcement agency and policing, patrol, investigations → entailed.
  - a SCHOOL DISTRICT and running schools; a HEALTH AGENCY and delivering clinical care → entailed.
Distinguish this from a distinct POPULATION or a specialized PROGRAM the entity type does NOT structurally perform (a community college and in-facility correctional EDUCATION; a behavioral-health nonprofit and a justice-involved POPULATION) — those remain nexus triggers when inferred. The structural default covers entity-type-typical FUNCTIONS/FACILITIES, not every topical adjacency.

PROCEDURE:
1. Name the qualifying dimension.
2. Walk EACH caveat and label it execution or nexus by the test above.
3. basis = inferred_from_adjacency ONLY if at least one genuine NEXUS caveat exists AND the qualifying function is not structurally entailed by the org's entity type. If every caveat is execution, or the function is structurally entailed, basis = entailed_by_identity.
4. If inferred_from_adjacency, put the ONE verbatim nexus caveat you keyed on in triggering_caveat. If you cannot quote a caveat that plainly states the qualifying FUNCTION/POPULATION itself is unconfirmed, the answer is entailed_by_identity and triggering_caveat is empty.

EXISTENCE TEST (applies only after the above): a single genuine nexus caveat decides inferred_from_adjacency even when many execution caveats surround it — do not average or vote it away. But it must be a GENUINE nexus caveat per the trigger definition, not an execution caveat re-read as one.

BIAS TOWARD entailed_by_identity WHEN AMBIGUOUS. Under-flagging a real match is the CHEAPER error; demoting a genuine county or clinic match off the surface costs more than leaving a possibly-generic one up. On any genuine coin-flip, choose entailed_by_identity.

Decide from the client's CONFIRMED identity (entity type, location, service area, funding needs, authoritative rules) and the first-pass caveats. Do not use any distilled narrative or assumed capability. Return the answer via the submit_nexus_judgment tool exactly once.`;

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
            triggering_caveat: {
              type: ["string", "null"],
              description:
                "When basis is inferred_from_adjacency, the ONE verbatim caveat that states the org may not perform the qualifying FUNCTION / serve the qualifying POPULATION at all. Empty/null for entailed_by_identity or when no such caveat can be quoted.",
            },
            rationale: { type: "string" },
          },
          required: ["qualifying_dimension", "basis", "triggering_caveat", "rationale"],
        },
      },
    ],
    tool_choice: { type: "tool", name: "submit_nexus_judgment" },
    messages: [
      {
        role: "user",
        content:
          `GRANT: ${grant.title}\n\n` +
          `SEAT MENU (context for the grant's target roles only — the client's seat/role is NOT the question; do not decide from it):\n${menu}\n\n` +
          `FIRST-PASS CAVEATS (label each execution vs nexus; classify the qualifying dimension named here):\n${caveats}\n\n` +
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
      triggering_caveat: null,
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
