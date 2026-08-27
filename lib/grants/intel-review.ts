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
//   FAIL-SAFE (two-part grounding guard). An ADVERSE verdict (demote / flag) APPLIES only when it
//     (1) cites a page we ACTUALLY FETCHED (groundedOnFetchedSource — host-level, deterministic) AND
//     (2) SURVIVES an adversarial refute (a skeptical second read of the fetched page text, phase 3),
//     else it is downgraded to "unverified" in code (finalizeIntel). This REPLACES the old
//     verbatim-quote test, which suppressed correct reads of allocation tables / PDFs (the JAG case)
//     just because the claim wasn't a clean contiguous substring: host-grounding + refute checks that
//     QA read a real source AND that the source actually backs the concern, without demanding a
//     quotable sentence. A flaky fetch, a from-memory claim, or a page that doesn't hold up on the
//     second read can never produce a confident demote. A source the pass cannot reach comes back as a
//     typed "could not retrieve" → unverified, never a guess.
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
  // The corrected per-factor structure (same shape as review_cards.factor_scores). Non-null only when an
  // adverse verdict APPLIES — so the displayed factor bars/rationale stay consistent with the new score.
  qa_factor_scores: FactorScores | null;
  summary: string;
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
  qa_factor_scores?: FactorScores | null;
  summary: string;
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

HOW TO VERIFY:
- You have ONE tool: fetch_grant_source, a read-only GET of a public U.S. .gov page. Use it. Read the authoritative source(s) you are given and the NOFO's own source URL. Follow a .gov link to the specific allocation / eligibility table when the landing page points to one.
- Verify against what you ACTUALLY READ, never from memory. If you cannot retrieve a source you need to decide, say so plainly — do NOT infer or reconstruct an allocation reality you could not read.
- Judge from the client's CONFIRMED identity (entity type, location, service area, rules) and the grant's authoritative rules. Ignore any distilled narrative.

YOUR VERDICT (state it explicitly at the end):
- AFFIRM: the engine's score and eligibility read hold up — the client genuinely fills the role the score implies.
- DEMOTE: the engine over-credited; the client cannot participate the way the score implies (e.g. can't prime — asterisk/disparate jurisdiction, MOU-partner-only). Name the score it SHOULD be (1, 2, or 3, lower than the engine's), and quote the source that establishes it.
- FLAG: a real eligibility concern worth surfacing, but not a clean score proposal.
- UNVERIFIED: you could not retrieve a source you needed to decide. This is an honest outcome, not a failure to hide.

GROUND every adverse call (demote or flag) in a page you ACTUALLY FETCHED, and give its URL. Cite the specific table row / cell / passage that establishes it — you do NOT need a clean contiguous verbatim sentence (allocation tables and PDFs rarely give one); a faithful account of the exact cell you read is enough. What you must NOT do is decide from memory, or cite a page you did not fetch. A verdict you cannot tie to a source you retrieved is UNVERIFIED, full stop.

Write a clear analysis: your verdict, the proposed score if demoting, the key evidence with source URLs (the closest supporting text from the fetched page), and exactly what you could and could not verify.`;

const STRUCTURE_SYSTEM_PROMPT = `Convert the IntellEngine QA analysis below into the structured verdict via the submit_intel_review tool, called exactly once.

Use ONLY what the analysis states — do not add findings it did not make.

GROUNDING (this is how you avoid hallucinating a concern): every evidence item's source_url MUST be a page the analysis ACTUALLY FETCHED (it appears in the "PAGES FETCHED" list). Quote the most specific span you can from that page — but you do NOT need a clean contiguous verbatim sentence: allocation tables, PDFs, and structured pages rarely yield one, and a correct read of a table is still a real finding. Give the closest supporting text or a faithful paraphrase of the exact cell/row, plus its source_url. What you may NOT do is cite a page the analysis never fetched, or a claim the fetched pages do not support. If the analysis reached an adverse read (demote/flag) but fetched no relevant page to back it, return verdict "unverified".

For "demote", qa_fit_score is the lower score the analysis named (1-3) and qa_factor_scores is the corrected six-factor object (rewrite only the factor(s) the finding changes — usually eligibility/seat_role — and carry the rest from the engine's read; the rewritten factor's rationale is the plain-language "why"). For "affirm"/"flag"/"unverified", leave qa_fit_score and qa_factor_scores null.

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
          "For 'demote' (and 'flag' when it changes a factor), the corrected six-factor object so the card's factor bars stay consistent with the new score. Null for affirm/unverified.",
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
const REFUTE_SYSTEM_PROMPT = `You are a skeptical reviewer checking an IntellEngine QA verdict before it changes a client's score. The QA pass proposed lowering (DEMOTE) or flagging this match. Your job is to try to REFUTE that concern using ONLY the fetched page text provided — do not use outside knowledge or memory.

Return supported=true ONLY if the fetched pages CLEARLY establish the concern (e.g. the allocation table really does list this jurisdiction as an asterisk/disparate unit that cannot prime). Return supported=false if the fetched pages do NOT establish it — including when the basis for the concern is not actually present in the fetched text, when the pages are ambiguous, or when they contradict the concern. When in doubt, supported=false: a score change must rest on what the sources actually show. Give a one-sentence reason.`;

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
export function intelContext(card: IntelCard, grant: Grant, client: Client, discovery = false): string {
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
      ? `FORMULA / ALLOCATION PROGRAM — CFDA ${formula.cfda} (${formula.program.label}): here ENTITY-TYPE eligibility is NOT application eligibility. ${formula.program.allocationNote} Verify the client against this allocation reality (the allocation table / State Administering Agency structure), not just the entity-type list. If the authoritative allocation page is not among the sources above, SEARCH for it, then fetch and read it.\n\n`
      : "";

  return (
    `GRANT\n` +
    `  Title: ${grant.title ?? "(untitled)"}\n` +
    `  Funder: ${grant.funder ?? "(unknown)"}\n` +
    `  CFDA / assistance listings: ${cfdas}\n` +
    `  Program type: ${grant.program_type ?? "(unknown)"}\n` +
    `  Eligible entity types (as extracted): ${(grant.eligible_entity_types ?? []).join("; ") || "(none stated)"}\n` +
    `  Geographic eligibility: ${grant.geographic_eligibility ?? "(none stated)"}\n` +
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

// The registrable host of a URL (lowercased, `www.` stripped), or null if unparseable. Used to check a
// cited source against the pages actually fetched — see groundedOnFetchedSource.
function hostOf(u: string): string | null {
  try {
    return new URL(u).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return null;
  }
}

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

// GROUNDING (replaces the old verbatim-quote guard). An adverse verdict must cite at least one page the
// pass ACTUALLY FETCHED (an `ok` audit record) — the model cannot ground a demote on a page it never
// retrieved. It no longer requires a verbatim substring to appear in the body: correct reads of allocation
// tables / PDFs rarely yield a clean contiguous span, and demanding one suppressed correct verdicts (the
// JAG case). The claim's CONTENT is checked separately by the adversarial refute (phase 3), which reads
// the real fetched bodies — so host-level grounding + refute is the anti-hallucination pair, deterministic
// half here (unit-tested), semantic half there. A cited path may differ slightly from the fetched path, so
// grounding is at the host level and the refute does the content verification.
export function groundedOnFetchedSource(evidence: IntelEvidence[], audit: FetchAuditRecord[]): boolean {
  const fetchedHosts = new Set<string>();
  for (const a of audit) {
    if (!a.ok) continue;
    for (const u of [a.finalUrl, a.url]) {
      const h = u ? hostOf(u) : null;
      if (h) fetchedHosts.add(h);
    }
  }
  if (fetchedHosts.size === 0) return false;
  return evidence.some((e) => {
    const h = e?.source_url ? hostOf(e.source_url) : null;
    return h != null && fetchedHosts.has(h);
  });
}

function clampScore(n: unknown): number | null {
  if (typeof n !== "number" || !Number.isFinite(n)) return null;
  const i = Math.round(n);
  return i < 1 ? 1 : i > 3 ? 3 : i;
}

const FACTOR_KEYS = ["seat_role", "eligibility", "geographic", "program_history", "cost_share", "mission"] as const;
const FACTOR_RATINGS = new Set(["strong", "moderate", "weak", "insufficient_data"]);

// Validate a model-returned corrected factor object into the exact review_cards.factor_scores shape, or
// null. All six factors must be present with a valid rating — a partial/garbage object is rejected whole
// (null) rather than half-written, so the display never coalesces a malformed factor set onto a card.
function sanitizeFactorScores(v: unknown): FactorScores | null {
  if (!v || typeof v !== "object") return null;
  const rec = v as Record<string, unknown>;
  const out: Record<string, { rating: string; rationale: string }> = {};
  for (const k of FACTOR_KEYS) {
    const f = rec[k];
    if (!f || typeof f !== "object") return null;
    const fr = f as Record<string, unknown>;
    if (typeof fr.rating !== "string" || !FACTOR_RATINGS.has(fr.rating)) return null;
    out[k] = { rating: fr.rating, rationale: typeof fr.rationale === "string" ? fr.rationale : "" };
  }
  return out as unknown as FactorScores;
}

// Turn the raw model verdict + the fetch audit into the stored IntelReview, applying the grounding guard.
// Pure and exported so the fail-safe is unit-tested without a live model. The correctness half of the guard
// (the adversarial refute) runs in runIntelReview; its result is passed in as `refuteSurvived`.
export function finalizeIntel(opts: {
  parsed: RawVerdict | null;
  audit: FetchAuditRecord[];
  // The web_search queries issued this pass (optional; defaults to none for the fetch-only / test paths).
  searched?: string[];
  // The adversarial refute result for an adverse verdict: true = the fetched pages back the demote (it
  // survived), false = refuted / could-not-confirm (fail-safe → unverified), null = not run (non-adverse,
  // or the verdict was already ungrounded). An adverse verdict APPLIES only when refuteSurvived === true.
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
      evidence: [],
    };
  }

  const confidence: IntelConfidence =
    parsed.confidence === "high" || parsed.confidence === "low" ? parsed.confidence : "medium";

  // Keep evidence with a real quote (the grounding signal); BLANK any unsafe source_url so a
  // model-emitted javascript:/data: URL can never reach the panel's anchor href.
  const evidence: IntelEvidence[] = (Array.isArray(parsed.evidence) ? parsed.evidence : [])
    .filter((e) => e && e.quote)
    .map((e) => ({
      claim: e.claim ?? "",
      quote: e.quote,
      source_url: isSafeHttpUrl(e.source_url ?? "") ? e.source_url : "",
    }));
  let verdict: IntelVerdict = parsed.verdict;
  let summary = (parsed.summary ?? "").trim();
  let unverified = false;
  let refute_survived: boolean | null = null;

  // THE FAIL-SAFE:
  //   - an ADVERSE call (demote/flag) applies only when it is (1) GROUNDED on a page actually fetched
  //     (groundedOnFetchedSource) AND (2) SURVIVED the adversarial refute (refuteSurvived === true). The
  //     old verbatim-quote test is gone — it suppressed correct reads of allocation tables/PDFs; the refute
  //     checks the claim against the real fetched content instead. Any shortfall → unverified (never a
  //     from-nothing demote).
  //   - an AFFIRM must rest on at least one SUCCESSFUL fetch, else it is "the model thinks it's fine but
  //     read no source" — not a web-backed affirmation → unverified.
  const hasSuccessfulFetch = audit.some((a) => a.ok);
  if (verdict === "demote" || verdict === "flag") {
    const grounded = hasSuccessfulFetch && groundedOnFetchedSource(evidence, audit);
    if (!grounded) {
      verdict = "unverified";
      unverified = true;
      refute_survived = null; // the refute never ran — nothing grounded to test
      summary =
        "QA proposed a concern but cited no page it actually retrieved — treated as unverified; manual check needed." +
        (summary ? ` (Model note: ${summary})` : "");
    } else if (opts.refuteSurvived === true) {
      refute_survived = true; // grounded AND survived the second read → applies
    } else if (opts.refuteSurvived === false) {
      // Grounded, but the skeptical second read GENUINELY did not confirm the concern against the fetched
      // pages — a real refutation. refute_survived stays false so staff/eval can trust "the sources don't
      // support this".
      verdict = "unverified";
      unverified = true;
      refute_survived = false;
      summary =
        "QA proposed a concern but it did not hold up against the fetched sources on a second read — treated as unverified; manual check needed." +
        (summary ? ` (Model note: ${summary})` : "");
    } else {
      // Grounded and adverse, but the refute COULD NOT COMPLETE (threw / no budget → null). Distinct from a
      // genuine refutation: refute_survived stays null and the summary says "could not complete", so a
      // technical failure is never mislabeled as "the sources don't support this" (it's a retry signal).
      verdict = "unverified";
      unverified = true;
      refute_survived = null;
      summary =
        "QA proposed a concern but the second-read verification could not complete — treated as unverified; manual check needed." +
        (summary ? ` (Model note: ${summary})` : "");
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
  // consistent with the new number. Flag/affirm/unverified leave the engine's factors in place.
  const qa_factor_scores: FactorScores | null =
    verdict === "demote" ? sanitizeFactorScores(parsed.qa_factor_scores) : null;

  return {
    ...base,
    verdict,
    confidence,
    qa_fit_score,
    qa_factor_scores,
    refute_survived,
    unverified,
    summary: summary || "(no summary)",
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

// The real phase-2 structured call (forced tool — the generic-nexus pattern).
async function realStructure(analysisText: string, audit: FetchAuditRecord[], timeoutMs: number): Promise<RawVerdict | null> {
  const anthropic = getAnthropicClient();
  const fetchedList =
    audit.map((a) => `  - ${a.ok ? "OK" : "FAILED"} ${a.finalUrl ?? a.url}${a.ok ? "" : ` (${a.reason})`}`).join("\n") ||
    "  (no fetches were made)";
  const res = await anthropic.messages.create(
    {
      model: INTEL_MODEL,
      max_tokens: 1500,
      // No `temperature`: claude-opus-5 rejects it (see realCallModel).
      system: STRUCTURE_SYSTEM_PROMPT,
      tools: [SUBMIT_TOOL],
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
          content: `THE QA CONCERN TO CHECK:\n${claim}\n\nFETCHED PAGE TEXT (the only evidence you may use):\n${pages}`,
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
  // The phase-3 adversarial refute (correctness half of the grounding guard). Injected in tests.
  refute?: (parsed: RawVerdict, fetchedBodies: string[], engineFitScore: number | null, timeoutMs: number) => Promise<RefuteResult>;
  fetcher?: (url: string) => Promise<FetchResult>;
  deadlineMs?: number;
  // Web-search discovery (INTEL_WEB_SEARCH_ENABLED). Defaults to the flag; overridable in tests so the
  // flag-on/off context + tool set are asserted deterministically without touching process.env.
  discovery?: boolean;
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
  // Caller-held sink for the web_search queries the pass issues (server-side). Drives both the per-pass
  // search budget (realCallModel drops the tool once spent) and the stored `searched` list.
  const searched: string[] = [];
  const callModel = opts.callModel ?? realCallModel(discovery, searched);
  const structure = opts.structure ?? realStructure;
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
  const parsed = await structure(loop.text, audit, INTEL_TOTAL_BUDGET_MS - (clock() - startMs));

  // Phase 3: the adversarial refute — the correctness half of the grounding guard. Only for an adverse
  // verdict that is grounded on a page actually fetched (else finalizeIntel unverifies it regardless, no
  // point spending a call). refuteSurvived stays null otherwise; finalizeIntel requires === true to APPLY
  // an adverse verdict, so any shortfall (no budget, thrown, refuted) fails safe to "unverified".
  let refuteSurvived: boolean | null = null;
  if (parsed && (parsed.verdict === "demote" || parsed.verdict === "flag")) {
    const grounded = audit.some((a) => a.ok) && groundedOnFetchedSource(parsed.evidence ?? [], audit);
    if (grounded) {
      const remaining = INTEL_TOTAL_BUDGET_MS - (clock() - startMs);
      if (remaining >= MIN_REFUTE_BUDGET_MS) {
        try {
          const r = await refute(parsed, fetchedBodies, card.fit_score, remaining);
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
