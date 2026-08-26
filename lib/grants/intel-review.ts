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
//   FAIL-SAFE. Because it never writes fit_score, a failed fetch CANNOT change a score. And an
//     ADVERSE verdict (demote / flag) that is not grounded on a page we actually fetched is
//     downgraded to "unverified" in code (finalizeIntel), so a flaky fetch or a from-memory claim
//     can never produce a confident demote. Fetch-only (fetchGrantSource) has no search, so a source
//     it cannot reach comes back as a typed "could not retrieve" → unverified, never a guess.
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
import type { Grant, Client } from "@/types/database";

// Opus, exclusively, for this path — a low-volume verification pass where quality matters and the
// per-card spend is small. Kept distinct from the matcher's MODEL so a QA pass never silently runs
// on Sonnet. (No `thinking` param: matches the codebase idiom on the current SDK; adaptive thinking
// is a later tuning knob once verified against the deployed @anthropic-ai/sdk version.)
export const INTEL_MODEL = "claude-opus-5";

// QA may need two reads (the NOFO, then the allocation table it links or the seed page), so one more
// round than GrantBot's chat default. Still tightly bounded, inside the route's maxDuration=300s.
export const MAX_INTEL_FETCH_ROUNDS = 3;
export const INTEL_DEADLINE_MS = 240_000;
// Total budget across BOTH phases, under the route's maxDuration=300s, with headroom left for the
// final DB write. Phase 2's timeout is what REMAINS of this after phase 1, so a slow phase 1 can't
// push the structuring call past the function limit.
export const INTEL_TOTAL_BUDGET_MS = 285_000;
export const INTEL_MAX_TOKENS = 4096;

export type IntelVerdict = "affirm" | "demote" | "flag" | "unverified";

export interface IntelEvidence {
  claim: string;
  source_url: string;
  quote: string;
}

// The stored jsonb (review_cards.intel_review). engine_fit_score / fetched / model / reviewed_* are
// stamped by code; verdict / qa_fit_score / summary / evidence come from the model, guarded.
export interface IntelReview {
  verdict: IntelVerdict;
  engine_fit_score: number | null;
  qa_fit_score: number | null; // PROPOSAL only — never written to review_cards.fit_score
  summary: string;
  evidence: IntelEvidence[];
  fetched: FetchAuditRecord[];
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
  qa_fit_score: number | null;
  summary: string;
  evidence: IntelEvidence[];
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

Ground EVERY adverse call (demote or flag) in a verbatim quote from a page you fetched, with its URL. A verdict you cannot ground on a retrieved source is UNVERIFIED, full stop.

Write a clear analysis: your verdict, the proposed score if demoting, the key quoted evidence with source URLs, and exactly what you could and could not verify.`;

const STRUCTURE_SYSTEM_PROMPT = `Convert the IntellEngine QA analysis below into the structured verdict via the submit_intel_review tool, called exactly once.

Use ONLY what the analysis states — do not add findings it did not make. For every evidence item, give the source URL and a VERBATIM quote from the fetched page the analysis relied on. If the analysis could not ground an adverse call (demote/flag) in a source it actually fetched, return verdict "unverified". For "demote", qa_fit_score is the lower score the analysis named (1-3); for "affirm"/"flag"/"unverified", leave qa_fit_score null.`;

const SUBMIT_TOOL = {
  name: "submit_intel_review",
  description: "Return the single structured QA verdict for this card. Call exactly once.",
  input_schema: {
    type: "object" as const,
    properties: {
      verdict: { type: "string", enum: ["affirm", "demote", "flag", "unverified"] },
      qa_fit_score: {
        type: ["integer", "null"],
        description: "For 'demote', the lower score the analysis proposed (1-3). Null otherwise.",
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
            source_url: { type: "string" },
            quote: { type: "string", description: "Verbatim span from the fetched page." },
          },
          required: ["claim", "source_url", "quote"],
        },
      },
    },
    required: ["verdict", "qa_fit_score", "summary", "evidence"],
  },
} as const;

// ── Context builder (pure) ───────────────────────────────────────────────────────────────────────

export function intelContext(card: IntelCard, grant: Grant, client: Client): string {
  const rc = card.reasoning_context ?? null;
  const cfdas = (grant.assistance_listings ?? []).map((a) => a?.number).filter(Boolean).join(", ") || "(none)";
  const sources = allocationSourcesFor(grant.assistance_listings ?? null);

  const authoritative =
    sources.length > 0
      ? sources
          .map((s) => `  - ${s.label}\n${s.urls.map((u) => `      ${u}`).join("\n")}`)
          .join("\n")
      : "  (no seeded allocation source for this program — verify against the NOFO source URL and any .gov links it carries)";

  return (
    `GRANT\n` +
    `  Title: ${grant.title ?? "(untitled)"}\n` +
    `  Funder: ${grant.funder ?? "(unknown)"}\n` +
    `  CFDA / assistance listings: ${cfdas}\n` +
    `  Program type: ${grant.program_type ?? "(unknown)"}\n` +
    `  Eligible entity types (as extracted): ${(grant.eligible_entity_types ?? []).join("; ") || "(none stated)"}\n` +
    `  Geographic eligibility: ${grant.geographic_eligibility ?? "(none stated)"}\n` +
    `  NOFO source URL: ${grant.source_url ?? "(none)"}\n\n` +
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

// Shortest quote we'll treat as evidence — a couple of words can coincidentally appear anywhere; a
// real cited span is longer.
const MIN_QUOTE_CHARS = 12;

function normalizeText(s: string): string {
  return s.toLowerCase().replace(/\s+/g, " ").trim();
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

// An adverse verdict must be grounded on a quote that ACTUALLY APPEARS in a page we fetched — NOT
// merely a URL on a host we happened to fetch. This is the anti-hallucination guard: after fetching
// one bja.ojp.gov page the model cannot cite a different path with an invented quote, because the
// quote is checked against the retrieved page bodies. Normalized (case + whitespace) so verbatim
// spans survive markup/whitespace differences; a quote that does not occur is not grounded.
export function quoteGroundedInBodies(evidence: IntelEvidence[], fetchedBodies: string[]): boolean {
  if (fetchedBodies.length === 0) return false;
  const bodies = fetchedBodies.map(normalizeText);
  return evidence.some((e) => {
    const q = e?.quote ? normalizeText(e.quote) : "";
    if (q.length < MIN_QUOTE_CHARS) return false;
    return bodies.some((b) => b.includes(q));
  });
}

function clampScore(n: unknown): number | null {
  if (typeof n !== "number" || !Number.isFinite(n)) return null;
  const i = Math.round(n);
  return i < 1 ? 1 : i > 3 ? 3 : i;
}

// Turn the raw model verdict + the fetch audit into the stored IntelReview, applying the grounding
// guard. Pure and exported so the fail-safe is unit-tested without a live model.
export function finalizeIntel(opts: {
  parsed: RawVerdict | null;
  audit: FetchAuditRecord[];
  // The bodies of the pages actually fetched (ok:true), for verifying a cited quote occurs in one.
  fetchedBodies: string[];
  engineFitScore: number | null;
  model: string;
  reviewedBy: string | null;
  now: string;
}): IntelReview {
  const { parsed, audit, fetchedBodies, engineFitScore, model, reviewedBy, now } = opts;

  const base = {
    engine_fit_score: engineFitScore,
    fetched: audit,
    model,
    reviewed_by: reviewedBy,
    reviewed_at: now,
  };

  // No usable structured output → unverified (ran, but produced nothing to act on). Never a demote.
  if (!parsed || !parsed.verdict) {
    return {
      ...base,
      verdict: "unverified",
      qa_fit_score: null,
      unverified: true,
      summary: "QA ran but produced no usable verdict — manual check needed.",
      evidence: [],
    };
  }

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

  // THE FAIL-SAFE, in two parts:
  //   - an ADVERSE call (demote/flag) must be grounded on a quote that actually appears in a fetched
  //     page (quoteGroundedInBodies) — a URL on a fetched host with an invented quote does not count;
  //   - an AFFIRM must rest on at least one SUCCESSFUL fetch — otherwise it is "the model thinks it's
  //     fine but read no source", which must not be shown as a web-backed affirmation.
  // Either shortfall → unverified. (An adverse verdict grounded on a quote implies a successful fetch,
  // so the two checks don't double-count.)
  const hasSuccessfulFetch = audit.some((a) => a.ok);
  if (verdict === "demote" || verdict === "flag") {
    if (!quoteGroundedInBodies(evidence, fetchedBodies)) {
      verdict = "unverified";
      unverified = true;
      summary =
        "QA proposed a concern but could not ground it on a quote from a page it actually retrieved — treated as unverified; manual check needed." +
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

  // qa_fit_score is a PROPOSAL, from the FINAL verdict. Demote → the (clamped) lower score; affirm →
  // the engine's own score; flag/unverified → null. It is never written to review_cards.fit_score.
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

  return {
    ...base,
    verdict,
    qa_fit_score,
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

// The real phase-1 callModel: Opus + the one fetch tool. Same tool_choice mapping as GrantBot.
function realCallModel(): CallModel {
  const anthropic = getAnthropicClient();
  return async ({ messages, tools, remainingMs }) => {
    const timeout = Math.min(290_000, Math.max(remainingMs, 5_000));
    const res = await anthropic.messages.create(
      {
        model: INTEL_MODEL,
        max_tokens: INTEL_MAX_TOKENS,
        temperature: 0,
        system: INTEL_SYSTEM_PROMPT,
        messages: messages as Anthropic.MessageParam[],
        ...(tools === "off" ? {} : { tools: [WEB_FETCH_TOOL] }),
        ...(tools === "auto" ? { tool_choice: { type: "auto" as const, disable_parallel_tool_use: true } } : {}),
        ...(tools === "none" ? { tool_choice: { type: "none" as const } } : {}),
      },
      { timeout, maxRetries: 1 },
    );
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
      temperature: 0,
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

// ── Orchestration ───────────────────────────────────────────────────────────────────────────────────

export interface RunIntelOptions {
  reviewedBy?: string | null;
  now?: () => string;
  // Injected seams for deterministic tests (no live model / network).
  callModel?: CallModel;
  structure?: (analysisText: string, audit: FetchAuditRecord[], timeoutMs: number) => Promise<RawVerdict | null>;
  fetcher?: (url: string) => Promise<FetchResult>;
  deadlineMs?: number;
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
  const callModel = opts.callModel ?? realCallModel();
  const structure = opts.structure ?? realStructure;

  // Phase 1: the bounded fetch loop. Audit records AND the fetched page bodies accumulate as fetches
  // run — the bodies are what the adverse-verdict quote is later verified against (fail-safe).
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
    messages: [{ role: "user", content: intelContext(card, grant, client) }],
    toolsEnabled: true,
    callModel,
    dispatch,
    now: clock,
    deadlineMs: opts.deadlineMs ?? INTEL_DEADLINE_MS,
    maxToolRounds: MAX_INTEL_FETCH_ROUNDS,
  });

  // Phase 2: structure the analysis into the typed verdict, then apply the grounding guard. It gets
  // whatever of the total budget phase 1 left, so the two phases together stay under maxDuration.
  const parsed = await structure(loop.text, audit, INTEL_TOTAL_BUDGET_MS - (clock() - startMs));

  return finalizeIntel({
    parsed,
    audit,
    fetchedBodies,
    engineFitScore: card.fit_score,
    model: INTEL_MODEL,
    reviewedBy: opts.reviewedBy ?? null,
    now: now(),
  });
}
