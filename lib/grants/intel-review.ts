// IntellEngine QA / review layer — the ON-DEMAND, staff-triggered pass (Brick 1).
//
// WHAT IT IS. A second look at a card that already SURFACED: an Opus + web-verification pass that
// re-checks the engine's fit score and eligibility read against the AUTHORITATIVE public source,
// and writes a plain-language verdict into review_cards.intel_review. It is the "prove it on-demand
// first, promote to automatic later" half of the QA plan — it runs only when a staffer clicks "Run
// IntellEngine Intel", never inline in the matching pipeline.
//
// TWO INVARIANTS, both structural (not merely prompted):
//   PROPOSAL-ONLY / ANNOTATE-ONLY. This module RETURNS an IntelReview payload; it never writes
//     fit_score / seat / decision / suppressed, and the route stores it in the ONE new column and
//     nothing else. So QA can never remove or re-score a card. The card keeps the engine's score;
//     the verdict says "engine 3 → QA says 1, here's why", and a human makes the call.
//   FAIL-SAFE (GROUNDING is the gate; the refute is advisory — PR F). An ADVERSE verdict (demote / flag)
//     APPLIES only when it is GROUNDED — the pass actually FETCHED a relevant .gov page (fetchGrantSource
//     is .gov-allowlisted and only fetches this grant's sources, so an ok fetch is a real authoritative
//     read). "Never demote from nothing": a from-memory claim, a flaky fetch, or a source the pass cannot
//     reach comes back as a typed "could not retrieve" → unverified, never a guess. The adversarial refute
//     (a skeptical second read of the fetched page text, phase 3) still RUNS and is RECORDED as an advisory
//     note (refute_survived true / false / null), but it NO LONGER vetoes the verdict — because a grounded
//     demote is never-hide, sourced, and one-click-revertible, so a redundant veto that also killed CORRECT
//     grounded demotes (an over-eager second read overturning a right JAG demote) wasn't worth keeping. The
//     earlier verbatim-quote test and cited-URL host-match were both retired for the same reason: over-strict
//     guards that suppressed correct fetched reads of allocation tables/PDFs.
//
// PROFILE-FREE, like the occupancy / nexus judges (#138→#140 discipline): it reads the client's
// CONFIRMED identity (clientContextForJudge — org type, location, service area, rules), never
// client_profile. The QA question is about the grant's authoritative eligibility reality + the
// client's raw identity, not a distilled narrative.
//
// SHAPE OF THE PASS: phase 1 is the bounded fetch loop (the tool-agnostic runToolLoop with the one
// read-only fetch_grant_source tool — the same guarded .gov GET GrantBot uses), where Opus reads the
// NOFO source + the seed-map allocation page(s) and writes an evidence-grounded analysis. Phase 2 is
// a forced-tool structured call (the generic-nexus pattern) that turns that analysis into the typed
// verdict. finalizeIntel then applies the grounding guard. Model errors THROW (the route 502s and
// stores nothing — no QA yet, retry); "ran but couldn't ground" is a real stored "unverified" verdict.

import type Anthropic from "@anthropic-ai/sdk";
import { getAnthropicClient } from "@/lib/anthropic";
import {
  runToolLoop,
  type CallModel,
  type ToolDispatch,
  type ModelTurn,
} from "@/lib/grantbot/tool-loop";
import {
  WEB_FETCH_TOOL,
  WEB_FETCH_TOOL_NAME,
  frameFetchResult,
  type FetchAuditRecord,
} from "@/lib/grantbot/web-fetch";
import { fetchGrantSource, type FetchResult } from "@/lib/grantbot/fetch";
import { clientContextForJudge } from "@/lib/grants/subseat-routing";
import { allocationSourcesFor } from "@/lib/grants/allocation-sources";
import { formulaProgramTag } from "@/lib/grants/formula-programs";
import { intelWebSearchEnabled, intelPhase1Config, serverSearchQueries } from "@/lib/grants/intel-web-search";
import { fitNarrativeEnabled, structureConfig, narrativeGuard, scrubCardSeatCodes } from "@/lib/grants/fit-narrative";
import { deadlineDaysLeft } from "@/lib/report/shape";
import type { Grant, Client, FactorScores } from "@/types/database";

// Opus, exclusively, for this path — a low-volume verification pass where quality matters and the
// per-card spend is small. Kept distinct from the matcher's MODEL so a QA pass never silently runs
// on Sonnet. (No `thinking` param: matches the codebase idiom on the current SDK; adaptive thinking
// is a later tuning knob once verified against the deployed @anthropic-ai/sdk version.)
export const INTEL_MODEL = "claude-opus-5";

// QA may need two reads (the NOFO, then the allocation table it links or the seed page), so one more
// round than GrantBot's chat default. Still tightly bounded, inside the route's maxDuration=300s.
export const MAX_INTEL_FETCH_ROUNDS = 3;
// With discovery on (INTEL_WEB_SEARCH_ENABLED), the pass may need to SEARCH for an unseeded allocation
// table and then FETCH it, so it gets a couple more rounds. Only used on the flag-on path — flag off
// stays on MAX_INTEL_FETCH_ROUNDS, byte-identical to today. Still bounded by INTEL_DEADLINE_MS.
export const MAX_INTEL_DISCOVERY_ROUNDS = 5;
export const INTEL_DEADLINE_MS = 240_000;
// Total budget across BOTH phases, under the route's maxDuration=300s, with headroom left for the
// final DB write. Phase 2's timeout is what REMAINS of this after phase 1, so a slow phase 1 can't
// push the structuring call past the function limit.
export const INTEL_TOTAL_BUDGET_MS = 285_000;
export const INTEL_MAX_TOKENS = 4096;
// Phase 3 (the adversarial refute) is only run when at least this much of the total budget remains — else
// there is no time to verify, and an unverified adverse verdict fails safe to "unverified" (score untouched).
export const MIN_REFUTE_BUDGET_MS = 8_000;
// (d) Phase 2 (structuring) reliability. A forced-tool SUBMIT call can occasionally come back without a
// usable verdict — truncated mid-tool-call, or a model punt. Retry it up to this many attempts total
// before finalizeIntel falls back to "unverified" (Phase 1 is deadline-bounded, so Phase 2 has budget to
// spare), and give the SUBMIT enough tokens that a rich demote (summary + changed-factor rationales) is not
// truncated in the first place. These make a silent no-verdict run rare, not a recurring flake.
export const STRUCTURE_MAX_ATTEMPTS = 3;
export const MIN_STRUCTURE_BUDGET_MS = 8_000;
// Headroom for the whole phase-2 tool call (summary + six factor rationales + sources + the client
// narrative). The narrative is a late field, so when the model over-writes — enumerating every seat — it
// is the narrative that gets guillotined mid-word ("…(S0_6, e."). The prompt now forbids that enumeration;
// this bump is the belt-and-suspenders so a rich-but-legitimate demote still lands whole.
export const INTEL_STRUCTURE_MAX_TOKENS = 4000;
// Cap on the fetched-page text handed to the refute call, so a few large .gov pages can't blow the context.
export const MAX_REFUTE_CHARS = 40_000;

export type IntelVerdict = "affirm" | "demote" | "flag" | "unverified";

// The model's self-reported confidence in the verdict. RECORDED for staff + the eval, but NOT the apply
// gate — a self-report is weak evidence, and gating apply on it would re-introduce the exact
// over-suppression the verbatim-quote guard caused. The real apply gate is grounded-on-a-fetched-source +
// SURVIVED the adversarial refute (see finalizeIntel). Confidence just annotates.
export type IntelConfidence = "high" | "medium" | "low";

export interface IntelEvidence {
  claim: string;
  source_url: string;
  quote: string;
}

// The stored jsonb (review_cards.intel_review). engine_fit_score / fetched / model / reviewed_* are
// stamped by code; verdict / qa_fit_score / qa_factor_scores / confidence / summary / evidence come from
// the model, guarded.
export interface IntelReview {
  verdict: IntelVerdict;
  confidence: IntelConfidence;
  engine_fit_score: number | null;
  qa_fit_score: number | null; // the applied/proposed score (null unless the verdict is an applied demote/affirm)
  // The corrected factor(s) — a PARTIAL of review_cards.factor_scores: ONLY the factor(s) the finding
  // changed (the apply-write merges them onto the engine's real factors). Non-null only when an adverse
  // verdict APPLIES — so the displayed factor bars/rationale stay consistent with the new score.
  qa_factor_scores: Partial<FactorScores> | null;
  summary: string;
  // CLIENT-SAFE integrated match paragraph (Step C, FIT_NARRATIVE_ENABLED). Non-null ONLY on an applied
  // demote whose narrative passed the framing guard — parallel to qa_factor_scores. Null on every other
  // verdict, when the flag is off, or when the guard nulled a leaky one → the card shows the engine
  // paragraph. Persisted + displayed in a later PR; today it is generated and stored on the verdict only.
  narrative: string | null;
  evidence: IntelEvidence[];
  fetched: FetchAuditRecord[];
  // The web_search queries the pass actually issued (server-side web_search). Empty when discovery is off
  // or the model never searched. Recorded so the eval can PROVE discovery was exercised (not just that a
  // fetch of a handed URL succeeded) and to make search usage visible to staff.
  searched: string[];
  // The adversarial refute outcome for an adverse verdict: true = ran and the demote SURVIVED (→ applied);
  // false = ran and the second read GENUINELY refuted it (→ unverified, "the sources don't support this");
  // null = it did not apply or could not complete — non-adverse/ungrounded, OR it threw / had no budget to
  // run (→ unverified, "could not complete", a retry signal, NOT a refutation). The false-vs-null split
  // keeps a technical failure distinguishable from a real refutation for staff + the eval.
  refute_survived: boolean | null;
  unverified: boolean;
  model: string;
  reviewed_by: string | null;
  reviewed_at: string;
}

// The fields the pass reads off the stored card — the engine's own claim, which QA critiques.
export interface IntelCard {
  fit_score: number | null;
  proposed_role: string | null;
  recommended_prime: string | null;
  why_this_org: string[] | null;
  before_you_approve: string[] | null;
  reasoning_context: {
    fit_score_derivation?: string;
    eligibility_analysis?: string;
    role_assignment_logic?: string;
  } | null;
}

// The raw model verdict, before code stamps/guards it.
interface RawVerdict {
  verdict: IntelVerdict;
  confidence?: IntelConfidence;
  qa_fit_score: number | null;
  qa_factor_scores?: Partial<FactorScores> | null;
  summary: string;
  // The client-safe narrative the phase-2 model wrote (present only when FIT_NARRATIVE_ENABLED added the
  // field to the tool schema). Guarded + demote-gated in finalizeIntel before it reaches IntelReview.
  narrative?: string | null;
  evidence: IntelEvidence[];
}

// The adversarial refute pass result (phase 3). `supported` = the fetched pages actually back the adverse
// verdict (it SURVIVES); false = the pages do not support it / contradict it (refuted → not applied).
interface RefuteResult {
  supported: boolean;
  reason: string;
}

// ── Prompts ──────────────────────────────────────────────────────────────────────────────────────

const INTEL_SYSTEM_PROMPT = `You are IntellEngine QA. A matching engine already SURFACED this (grant, client) pair with a fit score and an eligibility read. Your job is to VERIFY that read against the AUTHORITATIVE public source, and catch where the engine is confidently over-crediting.

THE ERROR YOU EXIST TO CATCH: for formula / allocation programs, ENTITY-TYPE eligibility is NOT APPLICATION eligibility. A NOFO can say "units of local government are eligible" while a specific jurisdiction is a disparate / "asterisk" unit on the program's allocation list that can only participate JOINTLY, THROUGH THE COUNTY OR STATE, or as an MOU partner — i.e. it CANNOT PRIME a direct application at all. The engine reads the entity-type list and scores a confident direct-recipient; the allocation reality says otherwise. Find that gap.

BUT DO NOT OVER-CORRECT — AFFIRM THE LEGITIMATE PRIME. A formula program's pass-through structure disqualifies the entity BENEATH it, not the one AT THE TOP of it. The DESIGNATED RECIPIENT is a genuine direct/prime applicant and you must AFFIRM it: the Governor-designated STATE ADMINISTERING AGENCY (the SAA), or a jurisdiction that is DIRECTLY ALLOCATED and may file on its OWN — i.e. NOT marked disparate / "asterisk" and NOT required to apply jointly. DEMOTE ONLY an entity that is NOT such a direct applicant — a nonprofit or other organization that participates as a SUBGRANTEE through the state agency; a disparate / "asterisk" jurisdiction that must apply JOINTLY (through a single fiscal agent, the county, or the SAA) — the asterisk / joint-application requirement is the disqualifier, NOT whether an allocation amount is shown for it, since a disparate unit can still carry its own formula figure; a non-entitlement locality that participates through the state. The pass-through merely EXISTING is not a demote reason — WHO the client is on the allocation source is. Before you demote, confirm against that source which side of this line the client falls on: the SAA, or a directly-allocated jurisdiction that files on its own, is the PRIME to affirm; a disparate/'asterisk' unit or a subgrantee is the demote. Affirming a genuine direct recipient is exactly as important as catching a genuine sub; a formula program is not a blanket demote.

A SECOND ERROR YOU EXIST TO CATCH — PURPOSE-FIT MISMATCH: the client is ENTITY-ELIGIBLE but does not perform the specific ACTIVITY the program funds, or does not serve the POPULATION it funds. A NOFO can make an org's entity TYPE eligible (any institution of higher education, any nonprofit) while the program funds a SPECIFIC kind of work. The engine reads the eligible entity type and scores a fit; the NOFO's stated PURPOSE shows the org does not do this work. Examples: a museum-workforce program (funds the professional development of museum staff / the museum field) matched to a community college that has NO museum; a national library-RESEARCH / field-innovation program (funds replicable, national-impact models and applied research) matched to a college whose library does routine LOCAL service. Read the NOFO, name the SPECIFIC funded activity or population, and compare it to the client's CONFIRMED identity.

THIS TEST IS CATEGORICAL, NOT COMPETITIVE — draw the line sharply, because a wrong demote here lowers a REAL match:
- DEMOTE only when the client's CONFIRMED identity does NOT perform the funded activity / serve the funded population AT ALL. Name the funded activity from the NOFO you read AND the client fact that rules it out (no museum; no research faculty; does not serve this population).
- A BROAD ASSET IS NOT THE FUNDED WORK. Having a library is not doing national library-innovation research; having a campus is not running a museum; being adjacent to a field is not doing the specific funded activity. Do not let "the org has X" stand in for "the org does the funded work."
- NEVER demote on ENTITY-ELIGIBILITY ALONE. That the client is "only" an eligible IHE / nonprofit is not a mismatch — it is the baseline the engine already scored.
- NEVER demote on COMPETITIVE WEAKNESS. A client that GENUINELY performs the funded activity but is smaller, newer, lacks the strongest track record, or faces stiff competition is a real applicant — AFFIRM it. "Weaker applicant" is not "does not do this work." If the client performs the funded activity / serves the funded population, AFFIRM even when it is not the strongest applicant.
- The corrected factor for a purpose mismatch is mission and/or program_history (what the org actually does), NOT eligibility or seat_role (which the allocation error above uses).
This is grounded exactly like the allocation error: you must FETCH the NOFO / program source and read the funded purpose there — never demote a purpose-fit from memory.

HOW TO VERIFY:
- You have ONE tool: fetch_grant_source, a read-only GET of a public U.S. .gov page. Use it. Read the authoritative source(s) you are given and the NOFO's own source URL. Follow a .gov link to the specific allocation / eligibility table when the landing page points to one.
- Verify against what you ACTUALLY READ, never from memory. If you cannot retrieve a source you need to decide, say so plainly — do NOT infer or reconstruct an allocation reality you could not read.
- Judge from the client's CONFIRMED identity (entity type, location, service area, rules) and the grant's authoritative rules. Ignore any distilled narrative.

YOUR VERDICT (state it explicitly at the end):
- AFFIRM: the engine's score and eligibility read hold up — the client is a directly-eligible recipient AND it genuinely performs the funded activity / serves the funded population (even if it is not the strongest applicant).
- DEMOTE: the engine over-credited. Either the client cannot participate the way the score implies (an allocation error — can't prime; asterisk/disparate jurisdiction; MOU-partner-only), OR the client is entity-eligible but does not perform the funded activity / serve the funded population (a purpose-fit mismatch). Name the score it SHOULD be (1, 2, or 3, lower than the engine's), and quote the source that establishes it.
- FLAG: a real ELIGIBILITY concern worth surfacing, but not a clean score proposal. A metadata / record defect on an OTHERWISE-ELIGIBLE recipient — a wrong program-type label, a mismatched CFDA in the record, a sibling program run by a different agency — is NOT an eligibility concern: AFFIRM the recipient and note the defect in your analysis; do not FLAG or demote on it.
- UNVERIFIED: you could not retrieve a source you needed to decide. This is an honest outcome, not a failure to hide.

GROUND every adverse call (demote or flag) in a page you ACTUALLY FETCHED, and give its URL. Cite the specific table row / cell / passage that establishes it — you do NOT need a clean contiguous verbatim sentence (allocation tables and PDFs rarely give one); a faithful account of the exact cell you read is enough. What you must NOT do is decide from memory, or cite a page you did not fetch. A verdict you cannot tie to a source you retrieved is UNVERIFIED, full stop.

Write a clear analysis: your verdict, the proposed score if demoting, the key evidence with source URLs (the closest supporting text from the fetched page), and exactly what you could and could not verify.`;

const STRUCTURE_SYSTEM_PROMPT = `Convert the IntellEngine QA analysis below into the structured verdict via the submit_intel_review tool, called exactly once.

Use ONLY what the analysis states — do not add findings it did not make.

GROUNDING (this is how you avoid hallucinating a concern): every evidence item's source_url MUST be a page the analysis ACTUALLY FETCHED (it appears in the "PAGES FETCHED" list). Quote the most specific span you can from that page — but you do NOT need a clean contiguous verbatim sentence: allocation tables, PDFs, and structured pages rarely yield one, and a correct read of a table is still a real finding. Give the closest supporting text or a faithful paraphrase of the exact cell/row, plus its source_url. What you may NOT do is cite a page the analysis never fetched, or a claim the fetched pages do not support. If the analysis reached an adverse read (demote/flag) but fetched no relevant page to back it, return verdict "unverified".

For "demote", qa_fit_score is the lower score the analysis named (1-3) and qa_factor_scores contains ONLY the factor(s) the finding actually changes — usually eligibility and/or seat_role for an allocation/eligibility miss, or mission and/or program_history for a purpose-fit miss (the org does not perform the funded activity / serve the funded population). Do NOT restate the factors you did not change: you were not given the engine's per-factor ratings, so inventing them would fabricate data. Code merges your changed factor(s) onto the engine's real factors. Each changed factor's rationale is the plain-language "why". For "affirm"/"flag"/"unverified", leave qa_fit_score and qa_factor_scores null.

confidence is your honest self-assessment of how solid the verdict is given what you read (high/medium/low).`;

// One factor's corrected rating + plain-language reason — the shape of review_cards.factor_scores entries.
const FACTOR_SCHEMA = {
  type: "object" as const,
  properties: {
    rating: { type: "string", enum: ["strong", "moderate", "weak", "insufficient_data"] },
    rationale: { type: "string" },
  },
  required: ["rating", "rationale"],
} as const;

const SUBMIT_TOOL = {
  name: "submit_intel_review",
  description: "Return the single structured QA verdict for this card. Call exactly once.",
  input_schema: {
    type: "object" as const,
    properties: {
      verdict: { type: "string", enum: ["affirm", "demote", "flag", "unverified"] },
      confidence: {
        type: "string",
        enum: ["high", "medium", "low"],
        description: "How solid the verdict is given what you actually read.",
      },
      qa_fit_score: {
        type: ["integer", "null"],
        description: "For 'demote', the lower score the analysis proposed (1-3). Null otherwise.",
      },
      qa_factor_scores: {
        type: ["object", "null"],
        description:
          "For 'demote' ONLY: an object with JUST the factor(s) your finding changes (usually eligibility and/or seat_role for an allocation/eligibility miss, or mission and/or program_history for a purpose-fit miss), so the card's factor bars stay consistent with the new score. Do NOT include factors you did not change — code merges these onto the engine's real factors. Null for affirm/flag/unverified.",
        properties: {
          seat_role: FACTOR_SCHEMA,
          eligibility: FACTOR_SCHEMA,
          geographic: FACTOR_SCHEMA,
          program_history: FACTOR_SCHEMA,
          cost_share: FACTOR_SCHEMA,
          mission: FACTOR_SCHEMA,
        },
      },
      summary: {
        type: "string",
        description: "One or two plain sentences: the verdict and its web-grounded reason (staff-facing).",
      },
      evidence: {
        type: "array",
        items: {
          type: "object",
          properties: {
            claim: { type: "string" },
            source_url: { type: "string", description: "A page the analysis actually fetched." },
            quote: { type: "string", description: "The closest supporting span/cell from that page (need not be a clean verbatim sentence)." },
          },
          required: ["claim", "source_url", "quote"],
        },
      },
    },
    required: ["verdict", "confidence", "qa_fit_score", "qa_factor_scores", "summary", "evidence"],
  },
} as const;

// The adversarial refute (phase 3). It replaces the verbatim-quote guard's job — checking the CLAIM against
// the real fetched content — with a skeptical second read: given ONLY the pages the pass fetched, does the
// evidence actually support lowering the score? It is deliberately biased toward NOT supporting, so a
// confident misread of a page (the failure the quote-guard was a proxy for) is caught. supported=true only
// when the fetched pages clearly back the concern.
const REFUTE_SYSTEM_PROMPT = `You are a skeptical reviewer checking an IntellEngine QA verdict before it changes a client's score. The QA pass proposed lowering (DEMOTE) or flagging this match. Your job is to try to REFUTE that concern using ONLY (a) the fetched .gov page text provided and (b) the client's CONFIRMED identity provided below — do NOT use any outside knowledge or memory of the program or the organization. Both are ground truth: the fetched page is the authoritative program source; the client's confirmed identity is the client record (entity type, service area, known constraints), not a guess.

The two concern types rest on different evidence — check the RIGHT source for each:
- ALLOCATION / eligibility (a disparate / "asterisk" jurisdiction or a subgrantee that cannot prime): the FETCHED PAGES must establish the client is on the sub / ineligible side of the allocation source.
- PURPOSE-FIT (the client is entity-eligible but does not perform the funded ACTIVITY / serve the funded POPULATION): this rests on TWO facts and BOTH must hold — the FUNDED PURPOSE must be established by the fetched page (this program funds museum-workforce / national library research / etc.), AND the client's LACK of that activity or population must be established by the client's CONFIRMED identity (the record shows no museum / no research capacity / does not serve this population). One without the other does NOT support the concern.

Return supported=true ONLY if the provided evidence CLEARLY establishes the concern. Return supported=false if it does not — including when the fetched pages do not establish the funded purpose, when the client's confirmed identity does not establish the missing activity/population, when the evidence is ambiguous, or when it contradicts the concern. When in doubt, supported=false: a score change must rest on what the sources and the confirmed record actually show. Give a one-sentence reason.`;

const REFUTE_TOOL = {
  name: "submit_refute_check",
  description: "State whether the fetched pages support the QA concern. Call exactly once.",
  input_schema: {
    type: "object" as const,
    properties: {
      supported: {
        type: "boolean",
        description: "true only if the fetched pages clearly establish the concern; false otherwise.",
      },
      reason: { type: "string", description: "One sentence: what the fetched pages do or do not show." },
    },
    required: ["supported", "reason"],
  },
} as const;

// ── Context builder (pure) ───────────────────────────────────────────────────────────────────────

// `discovery` (INTEL_WEB_SEARCH_ENABLED) adds the formula-program note when the grant is a known formula
// program — telling the pass that entity-type eligibility is not application eligibility here and to
// search for the allocation table if it is not seeded. Default false keeps the context byte-identical to
// today's fetch-only pass, so flag-off QA is unchanged.
export function intelContext(cardRaw: IntelCard, grant: Grant, client: Client, discovery = false): string {
  // SOURCE-SIDE scrub (Shannon, 2026-09-02): strip the matcher's internal seat/prime codes from the card's
  // prose BEFORE it is serialized into the QA/narrative model prompt, so the model never sees a code to echo
  // back into the client-facing narrative in the first place. This is the "fix the source" half; the
  // read-boundary strip (RationaleCard / resolveFit / this page's card-load scrub) stays the defensive
  // backup for the matcher-authored fields the matcher writes in the protected engine (which this can't
  // reach at their own source).
  const card = scrubCardSeatCodes(cardRaw);
  const rc = card.reasoning_context ?? null;
  const cfdas = (grant.assistance_listings ?? []).map((a) => a?.number).filter(Boolean).join(", ") || "(none)";
  const sources = allocationSourcesFor(grant.assistance_listings ?? null);

  const authoritative =
    sources.length > 0
      ? sources
          .map((s) => `  - ${s.label}\n${s.urls.map((u) => `      ${u}`).join("\n")}`)
          .join("\n")
      : "  (no seeded allocation source for this program — verify against the NOFO source URL and any .gov links it carries)";

  const formula = discovery ? formulaProgramTag(grant.assistance_listings ?? null) : { isFormula: false as const, cfda: null, program: null };
  const formulaNote =
    formula.isFormula && formula.program
      ? `FORMULA / ALLOCATION PROGRAM — CFDA ${formula.cfda} (${formula.program.label}): here ENTITY-TYPE eligibility is NOT application eligibility. ${formula.program.allocationNote} Verify the client against this allocation reality (the allocation table / State Administering Agency structure), not just the entity-type list — and confirm which SIDE the client is on: the DESIGNATED recipient (the State Administering Agency, or a directly-allocated jurisdiction that is NOT disparate/'asterisk' and files on its own) is the PRIME to AFFIRM; only a sub-participant (a subgrantee, a disparate/'asterisk' unit that must apply jointly regardless of any allocation amount shown, a non-entitlement locality) is the demote this catches. If the authoritative allocation page is not among the sources above, SEARCH for it, then fetch and read it.\n\n`
      : "";

  // Deadline signal (a date we hold, so it's deterministic and reliable). A PASSED deadline (strictly
  // past — a due-today grant is still winnable) makes the whole card a no-go elsewhere; the model does not
  // author that call, but knowing it keeps the reasoning coherent — it must NOT describe partners to line up
  // or steps to take "before the deadline" that has already gone. Fed as advisory context, never a gate here.
  const days = deadlineDaysLeft(grant.submission_deadline);
  const deadlineStatus =
    days !== null && days < 0
      ? "  ⚠ This submission deadline has ALREADY PASSED — the opportunity is closed; do not describe any step as still available before it."
      : "";

  return (
    `GRANT\n` +
    `  Title: ${grant.title ?? "(untitled)"}\n` +
    `  Funder: ${grant.funder ?? "(unknown)"}\n` +
    `  CFDA / assistance listings: ${cfdas}\n` +
    `  Program type: ${grant.program_type ?? "(unknown)"}\n` +
    `  Eligible entity types (as extracted): ${(grant.eligible_entity_types ?? []).join("; ") || "(none stated)"}\n` +
    `  Geographic eligibility: ${grant.geographic_eligibility ?? "(none stated)"}\n` +
    `  Submission deadline: ${grant.submission_deadline ?? "(none stated)"}\n${deadlineStatus ? deadlineStatus + "\n" : ""}` +
    `  NOFO source URL: ${grant.source_url ?? "(none)"}\n\n` +
    formulaNote +
    `AUTHORITATIVE SOURCES TO CHECK (fetch these; follow .gov links to the specific table):\n${authoritative}\n\n` +
    `THE ENGINE'S READ (what you are verifying):\n` +
    `  fit_score: ${card.fit_score ?? "(none)"}\n` +
    `  proposed_role: ${card.proposed_role ?? "(none)"}\n` +
    `  recommended_prime: ${card.recommended_prime ?? "(none)"}\n` +
    `  why_this_org:\n${(card.why_this_org ?? []).map((s) => `    - ${s}`).join("\n") || "    (none)"}\n` +
    `  before_you_approve:\n${(card.before_you_approve ?? []).map((s) => `    - ${s}`).join("\n") || "    (none)"}\n` +
    `  fit_score_derivation: ${rc?.fit_score_derivation?.trim() || "(none)"}\n` +
    `  eligibility_analysis: ${rc?.eligibility_analysis?.trim() || "(none)"}\n` +
    `  role_assignment_logic: ${rc?.role_assignment_logic?.trim() || "(none)"}\n\n` +
    `CLIENT (confirmed identity only):\n${clientContextForJudge(client)}`
  );
}

// ── Grounding guard + finalize (pure, the fail-safe) ───────────────────────────────────────────────

// GROUNDING. An adverse verdict (demote/flag) APPLIES only when the pass actually FETCHED a relevant .gov
// page for this grant (a successful `fetchGrantSource` GET → an `ok` audit record) AND the adversarial
// refute — which reads that fetched page text and is biased to refute — confirms the concern. The fetch is
// what proves QA read a real, authoritative source (fetchGrantSource is .gov-allowlisted, and it only ever
// fetches this grant's seeded / NOFO / discovered sources, so an ok fetch is relevant by construction); the
// refute is the content check. We deliberately DO NOT require the model to echo the fetched URL in its
// structured evidence: the phase-2 model reliably omits it even after reading the page, so that requirement
// gated out correct, fetched, refute-confirmable demotes ("cited no page" — the JAG-county case, three eval
// runs) BEFORE the refute could bless them. The URL echo was never the safety signal — the fetch audit
// proves the page was retrieved and the refute proves the page backs the claim. `hasSuccessfulFetch`
// (audit.some ok) is that grounding signal, computed inline in finalizeIntel / runIntelReview.

// A source_url is MODEL OUTPUT, and a fetched (untrusted) .gov page can steer the model to emit a
// `javascript:` / `data:` URL. Only http(s) is a safe anchor href; anything else is blanked so the
// staff panel never renders it as a clickable link (self-XSS guard). The panel guards again at render.
export function isSafeHttpUrl(u: string): boolean {
  try {
    const p = new URL(u).protocol;
    return p === "https:" || p === "http:";
  } catch {
    return false;
  }
}

// DISPLAY evidence: the sanitized list stored on the verdict and shown to staff. Keep only items with a real
// quote (the supporting text a human reads) and BLANK any unsafe source_url (a `javascript:`/`data:` URL can
// never reach the panel's anchor href). This is presentation only — it is NOT the grounding gate (that is
// hasSuccessfulFetch + the refute), so a demote still applies when the model gives thin evidence, as long as
// a real .gov page was fetched and the refute confirms it.
function sanitizeEvidence(raw: unknown): IntelEvidence[] {
  return (Array.isArray(raw) ? raw : [])
    .filter((e) => e && e.quote)
    .map((e) => ({
      claim: e.claim ?? "",
      quote: e.quote,
      source_url: isSafeHttpUrl(e.source_url ?? "") ? e.source_url : "",
    }));
}

function clampScore(n: unknown): number | null {
  if (typeof n !== "number" || !Number.isFinite(n)) return null;
  const i = Math.round(n);
  return i < 1 ? 1 : i > 3 ? 3 : i;
}

const FACTOR_KEYS = ["seat_role", "eligibility", "geographic", "program_history", "cost_share", "mission"] as const;
const FACTOR_RATINGS = new Set(["strong", "moderate", "weak", "insufficient_data"]);

// Validate a model-returned CORRECTED-FACTORS object into a PARTIAL review_cards.factor_scores shape. The
// model returns ONLY the factor(s) its finding changes (usually eligibility / seat_role) — NOT all six — so
// a valid subset is kept and the apply-write (lib/grants/intel-queue.ts) merges it onto the engine's REAL
// stored factor_scores at apply time. Requiring all six re-introduced the fabrication the review flagged:
// the model was never given the engine's per-factor ratings, so "carry the rest from the engine's read"
// meant inventing the five it didn't change. Here it only states what it changed; code carries the rest.
// Unknown keys and factors with an invalid rating are dropped; an empty / garbage object → null.
function sanitizeFactorScores(v: unknown): Partial<FactorScores> | null {
  if (!v || typeof v !== "object") return null;
  const rec = v as Record<string, unknown>;
  const out: Record<string, { rating: string; rationale: string }> = {};
  for (const k of FACTOR_KEYS) {
    const f = rec[k];
    if (!f || typeof f !== "object") continue;
    const fr = f as Record<string, unknown>;
    if (typeof fr.rating !== "string" || !FACTOR_RATINGS.has(fr.rating)) continue;
    out[k] = { rating: fr.rating, rationale: typeof fr.rationale === "string" ? fr.rationale : "" };
  }
  return Object.keys(out).length > 0 ? (out as unknown as Partial<FactorScores>) : null;
}

// Turn the raw model verdict + the fetch audit into the stored IntelReview, applying the grounding guard.
// Pure and exported so the fail-safe is unit-tested without a live model. The correctness half of the guard
// (the adversarial refute) runs in runIntelReview; its result is passed in as `refuteSurvived`.
export function finalizeIntel(opts: {
  parsed: RawVerdict | null;
  audit: FetchAuditRecord[];
  // The web_search queries issued this pass (optional; defaults to none for the fetch-only / test paths).
  searched?: string[];
  // The adversarial refute result for an adverse verdict, ADVISORY (PR F): true = the fetched pages back the
  // demote, false = the second read did not independently confirm it, null = not run / could-not-complete.
  // It is recorded + surfaced as a note but NEVER vetoes the verdict — a GROUNDED adverse verdict applies
  // regardless. (Only groundedness gates: an ungrounded adverse verdict is still unverified.)
  refuteSurvived?: boolean | null;
  engineFitScore: number | null;
  model: string;
  reviewedBy: string | null;
  now: string;
}): IntelReview {
  const { parsed, audit, engineFitScore, model, reviewedBy, now } = opts;

  const base = {
    engine_fit_score: engineFitScore,
    fetched: audit,
    searched: opts.searched ?? [],
    model,
    reviewed_by: reviewedBy,
    reviewed_at: now,
  };

  // No usable structured output → unverified (ran, but produced nothing to act on). Never a demote.
  if (!parsed || !parsed.verdict) {
    return {
      ...base,
      verdict: "unverified",
      confidence: "low",
      qa_fit_score: null,
      qa_factor_scores: null,
      refute_survived: null,
      unverified: true,
      summary: "QA ran but produced no usable verdict — manual check needed.",
      narrative: null,
      evidence: [],
    };
  }

  let confidence: IntelConfidence =
    parsed.confidence === "high" || parsed.confidence === "low" ? parsed.confidence : "medium";

  const evidence = sanitizeEvidence(parsed.evidence);
  let verdict: IntelVerdict = parsed.verdict;
  let summary = (parsed.summary ?? "").trim();
  let unverified = false;
  let refute_survived: boolean | null = null;

  // THE FAIL-SAFE (PR F — grounding is the gate, the refute is advisory):
  //   - an ADVERSE call (demote/flag) applies when it is GROUNDED — the pass fetched at least one relevant
  //     .gov page (hasSuccessfulFetch; fetchGrantSource is .gov-allowlisted and only fetches this grant's
  //     sources, so an ok fetch is a real authoritative read). The adversarial refute still runs and is
  //     recorded as an ADVISORY note (refute_survived true/false/null), but it does NOT veto the verdict:
  //     a grounded demote is never-hide, sourced, and one-click-revertible, so a redundant veto that also
  //     killed CORRECT grounded demotes (the JAG case) isn't worth keeping. An UNGROUNDED adverse verdict
  //     is still unverified — never a from-nothing demote.
  //   - an AFFIRM must rest on at least one SUCCESSFUL fetch, else it is "the model thinks it's fine but
  //     read no source" — not a web-backed affirmation → unverified.
  const hasSuccessfulFetch = audit.some((a) => a.ok);
  if (verdict === "demote" || verdict === "flag") {
    if (!hasSuccessfulFetch) {
      // NEVER DEMOTE FROM NOTHING — the gate is a REAL fetched .gov page. An adverse verdict with no
      // successful fetch is an assertion, not a web-backed finding → unverified. This is the safety that
      // actually matters, and it is UNCHANGED.
      verdict = "unverified";
      unverified = true;
      refute_survived = null; // no source was retrieved — nothing for the refute to read
      summary =
        "QA proposed a concern but could not retrieve a .gov source to verify against — treated as unverified; manual check needed." +
        (summary ? ` (Model note: ${summary})` : "");
    } else {
      // GROUNDED → the adverse verdict APPLIES. The adversarial refute is now ADVISORY, not a veto (PR F):
      // a grounded demote is bounded, sourced, never-hide, and one-click-revertible, so a redundant veto
      // that also killed CORRECT grounded demotes (MS County JAG — a right demote overturned by an
      // over-eager second read) isn't worth keeping. We still RUN the refute and RECORD its outcome for
      // staff/eval visibility (refute_survived = true / false / null) and append an advisory note when it
      // did not confirm — but it never changes the verdict. Grounding, not the refute, is the gate.
      refute_survived = opts.refuteSurvived ?? null;
      if (opts.refuteSurvived === false) {
        summary +=
          " (Advisory: an adversarial second read did not independently confirm this against the fetched sources — the grounded demote still applies; review the cited sources.)";
      } else if (opts.refuteSurvived === null) {
        summary += " (Advisory: the adversarial second read could not complete — the grounded demote still applies.)";
      }
      // verdict stays demote / flag
    }
  } else if (verdict === "affirm") {
    if (!hasSuccessfulFetch) {
      verdict = "unverified";
      unverified = true;
      summary =
        "QA could not retrieve a source to verify against, so this is not a web-backed affirmation — treated as unverified; manual check needed." +
        (summary ? ` (Model note: ${summary})` : "");
    }
  } else if (verdict === "unverified") {
    unverified = true;
  }

  // Confidence tracks the FINAL verdict, not the model's original self-report. When the fail-safe overrides
  // the model (grounding/refute failed → unverified), a stored "high confidence" next to "unverified" is
  // self-contradictory — the model never actually reached a trustworthy conclusion. Derate to "low", the
  // same value the no-usable-output early-return already stores.
  if (verdict === "unverified") confidence = "low";

  // qa_fit_score is the applied/proposed score, from the FINAL verdict. Demote → the (clamped) lower score;
  // affirm → the engine's own score; flag/unverified → null.
  let qa_fit_score: number | null = null;
  if (verdict === "demote") {
    if (engineFitScore == null || engineFitScore <= 1) {
      // Can't demote below the floor (1). A "demote" of a 1 is not a lower score, it's a concern —
      // record it as a flag rather than render a self-contradictory "engine 1 → QA 1".
      verdict = "flag";
    } else {
      const proposed = clampScore(parsed.qa_fit_score);
      // A demote must land BELOW the engine score; a >= or missing number steps down exactly one.
      const ceiling = engineFitScore - 1;
      qa_fit_score = proposed !== null && proposed <= ceiling ? proposed : Math.max(1, ceiling);
    }
  } else if (verdict === "affirm") {
    qa_fit_score = engineFitScore;
  }

  // Corrected factors ride only an APPLIED demote (a real score change), so the card's factor bars stay
  // consistent with the new number. A PARTIAL (only the changed factor(s)); the apply-write merges it onto
  // the engine's real factors. Flag/affirm/unverified leave the engine's factors in place.
  const qa_factor_scores: Partial<FactorScores> | null =
    verdict === "demote" ? sanitizeFactorScores(parsed.qa_factor_scores) : null;

  // The client-safe verdict narrative is the REASONING body under the card's directional call. It now rides
  // EVERY resolved verdict — affirm and flag as well as demote — so a go/marginal card carries its own
  // grounded reasoning, not just a demote. It is gated only by the framing guard; an unverified verdict (QA
  // couldn't ground) writes no narrative → the card shows today's engine paragraph, and a leaky/absent one
  // falls back the same way. Additive: it never touches the verdict/score/factors, so it cannot move the
  // number (the pin holds — the model writes reasoning under a call it cannot override).
  const narrative = verdict !== "unverified" ? narrativeGuard(parsed.narrative) : null;

  return {
    ...base,
    verdict,
    confidence,
    qa_fit_score,
    qa_factor_scores,
    refute_survived,
    unverified,
    summary: summary || "(no summary)",
    narrative,
    evidence,
  };
}

// ── Model wiring ───────────────────────────────────────────────────────────────────────────────────

// Extract a ModelTurn from an Anthropic response — mirrors GrantBot's turn.ts extraction exactly, so
// the live-call parsing is the proven one.
function modelTurnFromResponse(res: Anthropic.Message): ModelTurn {
  const text = res.content
    .map((b) => (b.type === "text" ? b.text : ""))
    .filter(Boolean)
    .join("\n")
    .trim();
  const toolUses = res.content
    .filter((b) => b.type === "tool_use")
    .map((b) => {
      const tb = b as { id: string; name: string; input?: unknown };
      return { id: tb.id, name: tb.name, input: tb.input ?? {} };
    });
  return {
    text,
    toolUses,
    stopReason: res.stop_reason ?? null,
    usage: {
      input_tokens: res.usage?.input_tokens ?? null,
      output_tokens: res.usage?.output_tokens ?? null,
      cache_read_input_tokens: res.usage?.cache_read_input_tokens ?? null,
      cache_creation_input_tokens: res.usage?.cache_creation_input_tokens ?? null,
    },
    rawContent: res.content,
  };
}

// The real phase-1 callModel: Opus + the fetch tool, plus (when discovery is on) Anthropic's server-side
// web_search. Same tool_choice mapping as GrantBot. `discovery=false` is byte-identical to the pre-search
// pass: system is INTEL_SYSTEM_PROMPT unchanged and the tool set is exactly [WEB_FETCH_TOOL].
// `searched` is a caller-held sink (same pattern as the fetch audit): each request records the web_search
// queries it issued, and the NEXT request's tool set is rebuilt from searched.length — so once the pass's
// search budget is spent, web_search is dropped (the per-PASS cap, not just per-request). The tool set +
// system come from the pure, unit-tested intelPhase1Config: off → [WEB_FETCH_TOOL] + base system
// (byte-identical); on → adds web_search (max_uses = remaining budget) + the addendum. The web_search entry
// is cast because this SDK (0.39.0) predates server-side tools and ships no type for it; the wire protocol
// carries it. tool_choice "none" also disables the server tool, so a pause_turn only arises under "auto".
function realCallModel(discovery: boolean, searched: string[]): CallModel {
  const anthropic = getAnthropicClient();
  return async ({ messages, tools, remainingMs }) => {
    const { tools: toolList, system } = intelPhase1Config(discovery, WEB_FETCH_TOOL, INTEL_SYSTEM_PROMPT, searched.length);
    const toolset = toolList as unknown as Anthropic.Tool[];
    const timeout = Math.min(290_000, Math.max(remainingMs, 5_000));
    const res = await anthropic.messages.create(
      {
        model: INTEL_MODEL,
        max_tokens: INTEL_MAX_TOKENS,
        // No `temperature`: claude-opus-5 REJECTS it — 400 "temperature is deprecated for this model"
        // (unlike the matcher's claude-sonnet-4-6, which still accepts temperature:0). The QA pass is a
        // verification read where the model's low-variance default is fine.
        system,
        messages: messages as Anthropic.MessageParam[],
        ...(tools === "off" ? {} : { tools: toolset }),
        ...(tools === "auto" ? { tool_choice: { type: "auto" as const, disable_parallel_tool_use: true } } : {}),
        ...(tools === "none" ? { tool_choice: { type: "none" as const } } : {}),
      },
      { timeout, maxRetries: 1 },
    );
    // Record the searches Anthropic ran inline this request, so the next round's budget + the eval's
    // discovery assertion both read real usage.
    for (const q of serverSearchQueries(res.content)) searched.push(q);
    return modelTurnFromResponse(res);
  };
}

// The real phase-2 structured call (forced tool — the generic-nexus pattern). `narrativeOn`
// (FIT_NARRATIVE_ENABLED) adds the client-safe `narrative` field to the tool + the writing spec to the
// system; OFF is byte-identical to the pre-C call (structureConfig returns the base tool/system unchanged).
async function realStructure(
  analysisText: string,
  audit: FetchAuditRecord[],
  timeoutMs: number,
  narrativeOn = false,
): Promise<RawVerdict | null> {
  const anthropic = getAnthropicClient();
  const fetchedList =
    audit.map((a) => `  - ${a.ok ? "OK" : "FAILED"} ${a.finalUrl ?? a.url}${a.ok ? "" : ` (${a.reason})`}`).join("\n") ||
    "  (no fetches were made)";
  const { tool: submitTool, system } = structureConfig(narrativeOn, SUBMIT_TOOL, STRUCTURE_SYSTEM_PROMPT);
  const res = await anthropic.messages.create(
    {
      model: INTEL_MODEL,
      // Headroom so a rich demote (summary + changed-factor rationales + client narrative) is not truncated
      // mid-tool-call, which returns a verdict-less result and forces a needless "no usable verdict".
      max_tokens: INTEL_STRUCTURE_MAX_TOKENS,
      // No `temperature`: claude-opus-5 rejects it (see realCallModel).
      system,
      tools: [submitTool],
      tool_choice: { type: "tool", name: SUBMIT_TOOL.name },
      messages: [
        {
          role: "user",
          content: `PAGES FETCHED DURING THE REVIEW:\n${fetchedList}\n\nQA ANALYSIS:\n${analysisText}`,
        },
      ],
    },
    // Bounded by the budget LEFT after phase 1 (passed in — NOT a fixed value that ignores elapsed
    // time), and maxRetries:0 so a client-side timeout does NOT retry and double the spend past the
    // route's 300s limit; it throws once into runIntelReview's caller → the route's clean 502. Clamped
    // to [5s, 60s] as a floor/ceiling on the remaining budget.
    { timeout: Math.max(5_000, Math.min(timeoutMs, 60_000)), maxRetries: 0 },
  );
  const tool = res.content.find((b) => b.type === "tool_use");
  if (!tool || tool.type !== "tool_use") return null;
  return tool.input as RawVerdict;
}

// The real phase-3 refute (forced tool). A skeptical second read of the fetched page text against the
// adverse verdict — the correctness half of the grounding guard. Returns supported=false on any shortfall
// (no structured result, ambiguous pages), so an adverse verdict only APPLIES on a clear supported=true.
async function realRefute(
  parsed: RawVerdict,
  fetchedBodies: string[],
  engineFitScore: number | null,
  timeoutMs: number,
  // The client's CONFIRMED identity (clientContextForJudge). A PURPOSE-FIT demote rests on TWO facts — the
  // funded purpose (on the fetched page) AND the client's lack of that activity (in the client record, NOT
  // on a .gov program page) — so without this the refute cannot establish the client-side half and correctly
  // returns supported=false, which under broad apply (requireRefuteClean) would leave every purpose-fit
  // demote staff-held and never lower the score (Codex #496 P1). It is ground truth, not memory.
  clientContext: string,
): Promise<RefuteResult> {
  const anthropic = getAnthropicClient();
  // Give EACH fetched page an equal share of the refute budget rather than slicing the fetch-order
  // concatenation as one blob. Otherwise a single large first page (e.g. a long NOFO fetched before the
  // allocation table) could consume the whole budget, dropping the later-fetched page that actually carries
  // the evidence — the refute model would then never see it and truthfully return supported=false,
  // downgrading a correct, grounded demote to "unverified" (the same truncation-suppression the verbatim
  // guard caused). Per-page capping guarantees every fetched page contributes.
  const perPage =
    fetchedBodies.length > 0 ? Math.max(1, Math.floor(MAX_REFUTE_CHARS / fetchedBodies.length)) : MAX_REFUTE_CHARS;
  const pages =
    fetchedBodies.map((b, i) => `--- FETCHED PAGE ${i + 1} ---\n${b.slice(0, perPage)}`).join("\n\n") ||
    "(no pages were fetched)";
  const claim =
    `QA verdict: ${parsed.verdict}` +
    (parsed.qa_fit_score != null ? ` (proposed score ${parsed.qa_fit_score}; engine had ${engineFitScore ?? "?"})` : "") +
    `\nConcern: ${parsed.summary ?? "(none)"}` +
    `\nCited evidence:\n${(parsed.evidence ?? []).map((e) => `  - ${e.claim} [${e.source_url}]: "${e.quote}"`).join("\n") || "  (none)"}`;
  const res = await anthropic.messages.create(
    {
      model: INTEL_MODEL,
      max_tokens: 600,
      // No `temperature`: claude-opus-5 rejects it (see realCallModel).
      system: REFUTE_SYSTEM_PROMPT,
      tools: [REFUTE_TOOL],
      tool_choice: { type: "tool", name: REFUTE_TOOL.name },
      messages: [
        {
          role: "user",
          content:
            `THE QA CONCERN TO CHECK:\n${claim}\n\n` +
            `CLIENT (confirmed identity — ground truth for the client-side half of a purpose-fit concern):\n${clientContext}\n\n` +
            `FETCHED PAGE TEXT (the authoritative program source; the ONLY web evidence you may use):\n${pages}`,
        },
      ],
    },
    { timeout: Math.max(5_000, Math.min(timeoutMs, 60_000)), maxRetries: 0 },
  );
  const tool = res.content.find((b) => b.type === "tool_use");
  if (!tool || tool.type !== "tool_use") return { supported: false, reason: "refute produced no structured result" };
  const out = tool.input as Partial<RefuteResult>;
  return { supported: out.supported === true, reason: typeof out.reason === "string" ? out.reason : "" };
}

// ── Orchestration ───────────────────────────────────────────────────────────────────────────────────

export interface RunIntelOptions {
  reviewedBy?: string | null;
  now?: () => string;
  // Injected seams for deterministic tests (no live model / network).
  callModel?: CallModel;
  structure?: (analysisText: string, audit: FetchAuditRecord[], timeoutMs: number) => Promise<RawVerdict | null>;
  // The phase-3 adversarial refute (correctness half of the grounding guard). Injected in tests. Takes the
  // client's confirmed identity so a purpose-fit demote's client-side fact (e.g. "no museum") is verifiable.
  refute?: (parsed: RawVerdict, fetchedBodies: string[], engineFitScore: number | null, timeoutMs: number, clientContext: string) => Promise<RefuteResult>;
  fetcher?: (url: string) => Promise<FetchResult>;
  deadlineMs?: number;
  // Web-search discovery (INTEL_WEB_SEARCH_ENABLED). Defaults to the flag; overridable in tests so the
  // flag-on/off context + tool set are asserted deterministically without touching process.env.
  discovery?: boolean;
  // Client-safe fit narrative (FIT_NARRATIVE_ENABLED). Defaults to the flag; overridable in tests. When on,
  // the phase-2 structuring call is asked for the `narrative` field and finalizeIntel guards + keeps it on
  // an applied demote.
  narrative?: boolean;
}

// Run the on-demand QA pass for one (card, grant, client). RETURNS an IntelReview; writes nothing.
// A model error PROPAGATES (the route 502s and stores nothing — no QA yet, retry); a "ran but could
// not ground it" outcome returns a real verdict:"unverified" for storage.
export async function runIntelReview(
  card: IntelCard,
  grant: Grant,
  client: Client,
  opts: RunIntelOptions = {},
): Promise<IntelReview> {
  const now = opts.now ?? (() => new Date().toISOString());
  const clock = () => Date.parse(now()) || 0;
  const startMs = clock();
  // ONE flag read, threaded to both the context (formula note) and the call (web_search tool + addendum)
  // so they can't diverge. Off → today's fetch-only pass, byte-identical.
  const discovery = opts.discovery ?? intelWebSearchEnabled();
  // Client-safe fit narrative (FIT_NARRATIVE_ENABLED). One flag read, bound into the phase-2 structure call
  // so an injected test `structure` (3-arg) is unaffected and the real one gets the narrative toggle. Off →
  // the field is never added to the tool schema, byte-identical to the pre-C structuring call.
  const narrativeOn = opts.narrative ?? fitNarrativeEnabled();
  // Caller-held sink for the web_search queries the pass issues (server-side). Drives both the per-pass
  // search budget (realCallModel drops the tool once spent) and the stored `searched` list.
  const searched: string[] = [];
  const callModel = opts.callModel ?? realCallModel(discovery, searched);
  const structure =
    opts.structure ?? ((text: string, audit: FetchAuditRecord[], ms: number) => realStructure(text, audit, ms, narrativeOn));
  const refute = opts.refute ?? realRefute;

  // Phase 1: the bounded fetch loop. Audit records AND the fetched page bodies accumulate as fetches
  // run — the bodies are what phase 3's adversarial refute reads to verify an adverse verdict (fail-safe).
  const audit: FetchAuditRecord[] = [];
  const fetchedBodies: string[] = [];
  const fetcher = opts.fetcher ?? fetchGrantSource;
  const dispatch: ToolDispatch = async (tu) => {
    if (tu.name !== WEB_FETCH_TOOL_NAME) return { resultText: `Unknown tool "${tu.name}". Nothing was done.` };
    const rawUrl = (tu.input as { url?: unknown })?.url;
    const url = typeof rawUrl === "string" ? rawUrl.trim() : "";
    if (!url) {
      audit.push({ url: "", ok: false, reason: "no_url", fetchedAt: now() });
      return { resultText: "No URL was provided to fetch. Ask for the .gov source URL rather than guessing one." };
    }
    const result = await fetcher(url);
    const { resultText, audit: rec } = frameFetchResult(url, result, now);
    audit.push(rec);
    if (result.ok) fetchedBodies.push(result.text);
    return { resultText };
  };

  const loop = await runToolLoop({
    messages: [{ role: "user", content: intelContext(card, grant, client, discovery) }],
    toolsEnabled: true,
    callModel,
    dispatch,
    now: clock,
    deadlineMs: opts.deadlineMs ?? INTEL_DEADLINE_MS,
    // Discovery (search + fetch) legitimately needs a couple more rounds than fetch-only; off keeps the
    // pre-search round budget.
    maxToolRounds: discovery ? MAX_INTEL_DISCOVERY_ROUNDS : MAX_INTEL_FETCH_ROUNDS,
  });

  // Phase 2: structure the analysis into the typed verdict. It gets whatever of the total budget phase 1
  // left, so the phases together stay under maxDuration.
  //
  // (d) GUARANTEE A STRUCTURED VERDICT: a forced-tool structuring call that returns without a usable verdict
  // is a transient model miss (truncation / a punt), NOT a real "nothing to act on" — retry it with the
  // remaining budget before finalizeIntel falls back, so a one-off structuring miss no longer silently loses
  // a real verdict. Phase 1 is deadline-bounded (INTEL_DEADLINE_MS < INTEL_TOTAL_BUDGET_MS), so Phase 2 has
  // budget to spare for the retries. A genuine post-retry failure stays an honest "no usable verdict" (rare),
  // never a fabricated one.
  let parsed = await structure(loop.text, audit, INTEL_TOTAL_BUDGET_MS - (clock() - startMs));
  for (let attempt = 1; attempt < STRUCTURE_MAX_ATTEMPTS && (!parsed || !parsed.verdict); attempt++) {
    const remaining = INTEL_TOTAL_BUDGET_MS - (clock() - startMs);
    if (remaining < MIN_STRUCTURE_BUDGET_MS) break;
    parsed = await structure(loop.text, audit, remaining);
  }

  // Phase 3: the adversarial refute — now ADVISORY (PR F). Still run for an adverse verdict grounded on a
  // page actually fetched (an ungrounded verdict is unverified regardless, so there is no point spending a
  // call), and its result is recorded as a staff-facing note. It NO LONGER vetoes the verdict — finalizeIntel
  // applies a grounded adverse verdict whether refuteSurvived is true, false, or null; only groundedness gates.
  let refuteSurvived: boolean | null = null;
  if (parsed && (parsed.verdict === "demote" || parsed.verdict === "flag")) {
    // Grounded = the pass fetched at least one relevant .gov page for the refute to read (the SAME signal
    // finalizeIntel gates on). Run the refute over those fetched bodies for the advisory note.
    const grounded = audit.some((a) => a.ok);
    if (grounded) {
      const remaining = INTEL_TOTAL_BUDGET_MS - (clock() - startMs);
      if (remaining >= MIN_REFUTE_BUDGET_MS) {
        try {
          // Pass the client's CONFIRMED identity so the refute can verify a purpose-fit demote's client-side
          // fact (e.g. "no museum") — it is not on any .gov program page (Codex #496 P1).
          const r = await refute(parsed, fetchedBodies, card.fit_score, remaining, clientContextForJudge(client));
          refuteSurvived = r.supported; // true = survived, false = genuinely refuted by the second read
        } catch {
          refuteSurvived = null; // COULD NOT COMPLETE the check (threw) — distinct from a genuine refutation;
          // still fails safe (finalizeIntel applies only on === true), but stored/summarized honestly as null.
        }
      } else {
        refuteSurvived = null; // no budget left to RUN the check — could-not-complete, not a refutation
      }
    }
  }

  return finalizeIntel({
    parsed,
    audit,
    searched,
    refuteSurvived,
    engineFitScore: card.fit_score,
    model: INTEL_MODEL,
    reviewedBy: opts.reviewedBy ?? null,
    now: now(),
  });
}
