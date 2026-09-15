// The dedicated "why this client fits this grant" analysis pass — the affirmative fit narrative that
// OPENS a GO/MARGINAL grant card's IntellEngine Intel box.
//
// WHY A SEPARATE PASS (not the QA narrative). The QA verdict pass (intel-review.ts) is a SCORER — it can
// move the displayed score (qa_fit_score apply) — so it is PROFILE-FREE by the #140 lock (it never reads
// client_profile). That structurally starves its narrative of the mission/priority material a real "why
// this client fits" case needs, and couples the narrative's PRESENCE to a flaky .gov fetch (an affirm with
// no successful fetch becomes "unverified" → no narrative). This pass is the deliberate opposite:
//   - It NEVER writes fit_score / seat / decision / suppressed / qa_* — it writes ONLY the fit_narrative*
//     columns (migration 0099), locked by a unit test. It is a RENDER-LAYER pass, not a scorer.
//   - BECAUSE it is not a scorer, the #140 profile-free rule does NOT bind it — it MAY (and does) read
//     client_profile (mission / funding_priorities / core_capabilities). That is the whole unlock: the
//     mission↔funds axis the QA narrative can't see. (#140 is scorer-only; reading the profile for a
//     display narrative is fine.)
//   - It runs on STORED data with NO fetch, so it is present on every go/marginal card, independent of
//     whether any .gov page was reachable.
//
// OWNERSHIP SPLIT (so the two narratives never stack). This owns the GO / MARGINAL affirmative case. The QA
// narrative (qa_narrative) keeps the DEMOTE / NO-GO reasoning. resolveFit (lib/report/qa-override.ts) picks
// by the displayed direction: a fresh fit_narrative wins on a displayed 2/3, else it falls through to the
// QA/engine paragraph. A displayed-1 (no-go / applied demote) never shows a fit_narrative.
//
// FRESHNESS = ONE snapshot, decoupled from the QA lifecycle. fit_narrative_fit_score snapshots the DISPLAYED
// (QA-coalesced) score the paragraph was written for. resolveFit honors the narrative only while it still
// equals the current displayed score — one rule that is BOTH the staleness guard AND the direction gate (a
// card that falls to no-go, by engine re-score OR QA demote, no longer matches a stored 2/3, so the
// narrative is withheld and this drain regenerates it). It has its own column, its own generator, and its
// own drain, so a QA re-run/clear never touches it.
//
// FLAG-GATED (FIT_ANALYSIS_ENABLED, default OFF) — the cron no-ops, no column is written, and resolveFit
// sees null columns = today's behavior, byte-identical. DISTINCT from the QA FIT_NARRATIVE_ENABLED flag.
//
// PURE-TESTABLE: the model call (generate) and the clock (now) are injected, so the context builder, the
// award reducer, the sparse-data handling, the freshness/eligibility logic, and the writes-ONLY-fit_narrative
// invariant are unit-tested with a fake DB and no network. The narrative QUALITY is the model-in-the-loop
// eval (fit-analysis.eval.test.ts), the trust gate before the flag is flipped.

import type Anthropic from "@anthropic-ai/sdk";
import { getAnthropicClient, OPUS_MODEL } from "@/lib/anthropic";
import { createServiceClient } from "@/lib/supabase/server";
import { narrativeGuard } from "@/lib/grants/fit-narrative";
import { resolveFit } from "@/lib/report/qa-override";
import { deadlineDaysLeft } from "@/lib/report/shape";
import type { ProgramAwardSummary } from "@/lib/grants/program-awards";
import type { Grant, Client, FactorScores } from "@/types/database";

type DB = ReturnType<typeof createServiceClient>;

// ── Flag + config (env-overridable) ────────────────────────────────────────────────────────────────
export function fitAnalysisEnabled(): boolean {
  return process.env.FIT_ANALYSIS_ENABLED === "true";
}

// Opus, deliberately (Shannon's call): this is the client-facing fit rationale, the paragraph whose quality
// is the entire reason for the pass — do not cost-optimize it. The per-row model is recorded so a later
// Sonnet A/B is a one-line change with data to compare. Same string as intel-review's INTEL_MODEL.
export const FIT_ANALYSIS_MODEL = OPUS_MODEL;

const numEnv = (v: string | undefined, d: number): number => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : d;
};
const intEnv = (v: string | undefined, d: number): number => Math.floor(numEnv(v, d));

// A single Opus call (no fetch, no loop): ~2-4K input + a short paragraph out. A flat estimate is enough
// for the daily ceiling (a safety cap, not billing).
export const FIT_EST_COST_PER_CARD_USD = numEnv(process.env.FIT_ANALYSIS_EST_COST_PER_CARD_USD, 0.1);
// Hard daily ceiling: once today's generated count × the estimate reaches this, the drain stops for the day.
// Counted off the fit_narrative_at column itself — no separate ledger table.
export const FIT_ANALYSIS_DAILY_CAP_USD = numEnv(process.env.FIT_ANALYSIS_DAILY_CAP_USD, 20);
// How many cards one invocation generates for (also bounded by the daily cap's remaining budget).
export const FIT_ANALYSIS_BATCH = intEnv(process.env.FIT_ANALYSIS_BATCH, 5);
// Generations run in parallel per invocation (I/O-bound on the model).
export const FIT_ANALYSIS_CONCURRENCY = intEnv(process.env.FIT_ANALYSIS_CONCURRENCY, 3);
// Bound how far the poll scans past already-fresh cards to reach stale ones (FIT_ANALYSIS_BATCH × pages),
// so a large fresh prefix can't make one poll run unbounded (the QA poller's INTEL_POLL_MAX_PAGES pattern).
export const FIT_POLL_MAX_PAGES = intEnv(process.env.FIT_ANALYSIS_POLL_MAX_PAGES, 20);
export const FIT_POLL_PAGE_SIZE = intEnv(process.env.FIT_ANALYSIS_POLL_PAGE_SIZE, 100);
export const FIT_NARRATIVE_MAX_TOKENS = intEnv(process.env.FIT_ANALYSIS_MAX_TOKENS, 800);

// ── The prompt ─────────────────────────────────────────────────────────────────────────────────────

export const FIT_ANALYSIS_SYSTEM_PROMPT = `You are IntellEngine, writing the "why this client fits this grant" rationale that OPENS a grant's match card. A GRANTED grant strategist is deciding whether to put this opportunity in front of this client, and the client often reads it too. Write the fit case a sharp grants strategist would — clear enough that the reader gets the fit from the first sentence or two, without decoding any score bars.

Everything you need is provided below, all from GRANTED's own records. You have NO web access and no other sources — reason only from what is given, and introduce no new specific claim (dollar figures, dates, citations, program requirements) beyond it.

BUILD THE FIT CASE ACROSS FOUR THINGS, in plain language, leading with whatever is most decisive:

1. ELIGIBILITY — is this client's entity type an eligible applicant here? State it plainly ("An eligible applicant as a community college", "Eligible to apply as a unit of local government"). Entity-eligibility is the FLOOR, not the case — never let "they're eligible" read as the reason to pursue.

2. MISSION & PRIORITY ↔ WHAT IT FUNDS — the heart of it. Connect what this client actually does and wants to fund (its mission, program areas, stated funding priorities) to what THIS program funds (the program brief). Name the specific overlap, not a vague theme. If the fit is thematic but the client's history in the SPECIFIC funded activity is unconfirmed, say so honestly — do not manufacture a program history the record doesn't show.

3. ROLE — state the capacity to pursue in and why, in plain terms (why they can prime, or why they'd join under an eligible prime type). Use the role reasoning given; never invent a partner or a structure the record doesn't support.

4. AWARD HISTORY — STATE PRESENCE ONLY. If in-state award history is provided, you MAY note that the program has awarded $X across N awards to recipients in the client's state (a signal it funds work there). HARD RULES, no exceptions:
   • Use ONLY the state-level total/count you are given.
   • Say NOTHING about what TYPE of applicant wins or doesn't — you have no applicant-type data. Never write "usually goes to counties", "no city has won", "typically universities", or any claim about the kind of organization that receives these awards.
   • If no award history is provided, do not mention awards at all. Never infer or estimate one.

ELIGIBLE ≠ COMPETITIVE — say both when they diverge. An eligible entity can still be functionally weak for the funded work; a genuine-fit org can still be a smaller applicant. Be honest about the real hurdle: this card is marked either a STRONG match or a CONDITIONAL one. For a CONDITIONAL match, name the actual catch in one clause — the partner or match to line up, the unconfirmed program area, the narrower slice than it first appears. A rationale that hides the catch is worse than useless. Never oversell.

WHEN CLIENT DATA IS SPARSE — a common case, and the one you must NOT paper over. If the client's mission, funding priorities, and capabilities are thin or absent, DO NOT produce mail-merge filler ("This eligible applicant seeks funding for. The program funds…"). Write a SHORTER, honest fit note from what IS known — eligibility, the recommended role, and the funded purpose — and stop. Do NOT fabricate or pad a mission the record doesn't contain, and do not invent program history. A thin-but-honest two sentences beats a padded five. Being brief here is correct, not a failure.

VOICE:
- Two to five sentences, ONE paragraph, plain prose (fewer is fine when the data is thin). No bullet lists, no headings, no dollar tables beyond the single state-presence figure, and NO numeric fit score.
- Written AS advice the client can read. Say the fit directly. Never mention a "score", a "verdict", the engine, the scorer, "QA", or any internal machinery — and never write an internal seat/role code (S0_2, P0); name the capability in plain words.
- The card states the go/marginal call itself, so do NOT open with "Go"/"Marginal" or the client's name — open with the single most decisive fit reason.

Return the paragraph via submit_fit_narrative, called exactly once.`;

const SUBMIT_TOOL = {
  name: "submit_fit_narrative",
  description: "Return the client-facing 'why this client fits this grant' paragraph. Call exactly once.",
  input_schema: {
    type: "object" as const,
    properties: {
      narrative: {
        type: "string",
        description:
          "2–5 sentences (fewer when the client data is thin), one paragraph, plain prose. The affirmative " +
          "fit case. No numeric score, no go/no-go label, no internal machinery or seat codes.",
      },
    },
    required: ["narrative"],
  },
} as const;

// ── Award-history reducer (pure) ───────────────────────────────────────────────────────────────────

export interface AwardPresence {
  // The client's-STATE row, only when there is POSITIVE in-state presence. Null → the prompt says nothing
  // about awards (Shannon's silent-on-zero-in-state default — no "no AR awards" absence statement).
  inState: { state: string; amount: number; count: number } | null;
  // The national total, surfaced ONLY alongside a positive in-state signal (both are state-presence scale;
  // a national line with no in-state line risks reading as a competitiveness claim). Null otherwise.
  national: { amount: number; count: number } | null;
}

// Reduce the stored ProgramAwardSummary to STATE-PRESENCE ONLY. The recipient NAMES (topAwards) and the
// full per-state breakdown are DELIBERATELY DROPPED — never handed to the model — so no by-applicant-type
// claim is even constructible from the prompt (the structural half of the guardrail; the prompt is the
// other half). Zero/absent in-state → both null (say nothing). Null summary → both null.
export function reduceAwardHistory(
  summary: ProgramAwardSummary | null | undefined,
  clientState: string | null | undefined,
): AwardPresence {
  if (!summary || !Array.isArray(summary.byState)) return { inState: null, national: null };
  const st = (clientState ?? "").trim().toUpperCase();
  const row = st ? summary.byState.find((s) => (s?.state ?? "").toUpperCase() === st) : undefined;
  const inState =
    row && Number(row.amount) > 0 && Number(row.count) > 0
      ? { state: row.state, amount: Number(row.amount), count: Number(row.count) }
      : null;
  const totalAmount = Number(summary.totalAmount) || 0;
  const totalCount = Number(summary.totalAwardsFetched) || 0;
  const national = inState && totalAmount > 0 ? { amount: totalAmount, count: totalCount } : null;
  return { inState, national };
}

// Compact factual dollars (award HISTORY is USASpending actuals, not a projected award size, so it is NOT
// labeled an estimate — the "label award amounts as estimates" rule is about a grant's award ceiling).
function fmtUsd(n: number): string {
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `$${Math.round(n / 1_000)}K`;
  return `$${Math.round(n)}`;
}

// ── Context builder (pure) ─────────────────────────────────────────────────────────────────────────

// The card fields the pass reads — the engine's own match read (role + reasoning), never re-scored here.
export interface FitCard {
  fit_score: number | null;
  proposed_role: string | null;
  recommended_prime: string | null;
  why_this_org: string[] | null;
  reasoning_context: { role_assignment_logic?: string; [k: string]: unknown } | null;
}

const clean = (s: string | null | undefined) => (typeof s === "string" ? s.trim() : "");
const list = (a: string[] | null | undefined) => (Array.isArray(a) ? a.filter((x) => clean(x)) : []);

// True when the client's mission, funding priorities, and capabilities are all thin/absent — the sparse-data
// case the prompt handles by writing a shorter honest note instead of mail-merge filler.
export function isProfileSparse(client: Pick<Client, "client_profile" | "primary_funding_needs">): boolean {
  const cp = client.client_profile;
  const mission = clean(cp?.mission);
  const priorities = list(cp?.funding_priorities);
  const capabilities = list(cp?.core_capabilities);
  // primary_funding_needs is a raw client field that survives even a thin profile; count it so a client with
  // no distilled profile but real stated needs is not treated as fully sparse.
  const needs = list(client.primary_funding_needs);
  return !mission && priorities.length === 0 && capabilities.length === 0 && needs.length === 0;
}

// The grant fields the pass reads.
export type FitGrant = Pick<
  Grant,
  | "title"
  | "funder"
  | "description_brief"
  | "description"
  | "eligible_entity_types"
  | "program_type"
  | "geographic_eligibility"
  | "submission_deadline"
>;

// Build the model context: profile-INCLUSIVE (the unlock), award reduced to state-presence-only, and the
// displayed band as a STRONG/CONDITIONAL word (never the number, so the model can't print a score). Empty
// fields render "(not on file)" so the model SEES the absence and takes the sparse-data path rather than
// inventing. Pure + exported for the unit test.
export function buildFitContext(input: {
  grant: FitGrant;
  client: Client;
  card: FitCard;
  band: "strong" | "conditional";
  award: AwardPresence;
}): string {
  const { grant, client, card, band, award } = input;
  const cp = client.client_profile;

  const mission = clean(cp?.mission);
  const priorities = list(cp?.funding_priorities);
  const capabilities = list(cp?.core_capabilities);
  const needs = list(client.primary_funding_needs);
  const serviceArea = list(client.service_area);
  const location = [client.location_city, client.location_state].filter(Boolean).join(", ");
  const eligibleTypes = list(grant.eligible_entity_types).map((t) => t.replace(/_/g, " "));
  const fundedPurpose = clean(grant.description_brief) || clean(grant.description) || "(no program brief on file)";

  const awardLine = award.inState
    ? `In ${award.inState.state}: ${fmtUsd(award.inState.amount)} across ${award.inState.count} award${award.inState.count === 1 ? "" : "s"} (~10-yr window).` +
      (award.national ? ` Nationally: ${fmtUsd(award.national.amount)} across ${award.national.count} awards.` : "")
    : "No in-state program award history on file — do not mention awards.";

  const deadline = clean(grant.submission_deadline) || "(none stated)";
  const days = deadlineDaysLeft(grant.submission_deadline);
  const closedNote = days !== null && days < 0 ? "  ⚠ The submission deadline has already passed." : "";

  return (
    `THIS CARD IS A ${band.toUpperCase()} MATCH.\n\n` +
    `GRANT\n` +
    `  Title: ${clean(grant.title) || "(untitled)"}\n` +
    `  Funder: ${clean(grant.funder) || "(unknown)"}\n` +
    `  What it funds (program brief): ${fundedPurpose}\n` +
    `  Eligible applicants (as extracted): ${eligibleTypes.join("; ") || "(none stated)"}\n` +
    `  Program type: ${clean(grant.program_type) || "(unknown)"}\n` +
    `  Geographic eligibility: ${clean(grant.geographic_eligibility) || "(none stated)"}\n` +
    `  Submission deadline: ${deadline}\n${closedNote ? closedNote + "\n" : ""}` +
    `\nPROGRAM AWARD HISTORY (recipient STATE presence only; state totals only — no applicant-type data)\n` +
    `  ${awardLine}\n\n` +
    `THE MATCH (the engine's read — reason from it, do not re-score)\n` +
    `  Recommended role: ${clean(card.proposed_role) || "(none)"}` +
    (clean(card.recommended_prime) ? ` (would join under: ${clean(card.recommended_prime)})` : "") +
    `\n` +
    `  Role reasoning: ${clean(card.reasoning_context?.role_assignment_logic) || "(none)"}\n` +
    `  Engine's fit notes:\n${list(card.why_this_org).map((s) => `    - ${s}`).join("\n") || "    (none)"}\n\n` +
    `CLIENT\n` +
    `  Name: ${clean(client.name) || "(unnamed)"}\n` +
    `  Entity type: ${clean(client.org_type) || "(not on file)"}\n` +
    `  Location: ${location || "(not on file)"}\n` +
    `  Service area: ${serviceArea.join(", ") || "(not on file)"}\n` +
    `  Mission: ${mission || "(not on file)"}\n` +
    `  Funding priorities: ${priorities.join("; ") || "(not on file)"}\n` +
    `  Stated funding needs: ${needs.join("; ") || "(not on file)"}\n` +
    `  Capabilities: ${capabilities.join("; ") || "(not on file)"}`
  );
}

// ── Model wiring (injected seam) ───────────────────────────────────────────────────────────────────

// A single forced-tool Opus call — no fetch, no loop. Returns the raw narrative string, or null on any
// shortfall (no tool_use, non-string). The caller guards it (narrativeGuard) before storing.
export type FitGenerate = (context: string, timeoutMs: number) => Promise<string | null>;

async function realGenerate(context: string, timeoutMs: number): Promise<string | null> {
  const anthropic = getAnthropicClient();
  const res = await anthropic.messages.create(
    {
      model: FIT_ANALYSIS_MODEL,
      max_tokens: FIT_NARRATIVE_MAX_TOKENS,
      // No `temperature`: claude-opus-5 rejects it (400), same as the QA pass.
      system: FIT_ANALYSIS_SYSTEM_PROMPT,
      tools: [SUBMIT_TOOL] as unknown as Anthropic.Tool[],
      tool_choice: { type: "tool", name: SUBMIT_TOOL.name },
      messages: [{ role: "user", content: context }],
    },
    { timeout: Math.max(5_000, Math.min(timeoutMs, 60_000)), maxRetries: 1 },
  );
  const tool = res.content.find((b) => b.type === "tool_use");
  if (!tool || tool.type !== "tool_use") return null;
  const narrative = (tool.input as { narrative?: unknown }).narrative;
  return typeof narrative === "string" ? narrative : null;
}

// Generate + guard the narrative for one (card, grant, client). PROFILE-INCLUSIVE by design (this is NOT a
// scorer). Returns the client-safe paragraph, or null when the model shortfalls or the guard nulls a leak →
// the card keeps today's engine paragraph. `band` is the displayed direction (2 → conditional, 3 → strong).
export async function generateFitNarrative(
  card: FitCard,
  grant: FitGrant,
  client: Client,
  band: "strong" | "conditional",
  opts: { generate?: FitGenerate; timeoutMs?: number } = {},
): Promise<string | null> {
  const generate = opts.generate ?? realGenerate;
  const award = reduceAwardHistory(
    (grant as unknown as { program_award_summary?: ProgramAwardSummary | null }).program_award_summary ?? null,
    client.location_state,
  );
  const context = buildFitContext({ grant, client, card, band, award });
  const raw = await generate(context, opts.timeoutMs ?? 60_000);
  // narrativeGuard = the same client-safety net the QA narrative uses: nulls a staff-voice/machinery leak,
  // strips seat/role codes. Null → the display falls back to the engine paragraph.
  return narrativeGuard(raw);
}

// ── The write (the ONLY review_cards mutation this module makes) ─────────────────────────────────────

// The fit_narrative* patch. EVERY key is fit_narrative-prefixed — the structural guarantee this pass never
// writes an engine/QA column (locked by the "writes ONLY fit_narrative* columns" test). fit_narrative_fit_score
// snapshots the DISPLAYED score the paragraph was written for (resolveFit's freshness + direction gate).
export interface FitNarrativePatch {
  fit_narrative: string | null;
  fit_narrative_fit_score: number | null;
  fit_narrative_model: string | null;
  fit_narrative_at: string;
}

export function buildFitPatch(narrative: string | null, displayedFit: number, model: string, nowIso: string): FitNarrativePatch {
  // A null narrative (model shortfall / guard-nulled) still STAMPS fit_narrative_at so the poller does not
  // re-pick the card every cycle and burn spend on a card the model can't write cleanly; it clears the text
  // and snapshot so resolveFit shows the engine paragraph. A real narrative stores text + the freshness snapshot.
  return narrative
    ? { fit_narrative: narrative, fit_narrative_fit_score: displayedFit, fit_narrative_model: model, fit_narrative_at: nowIso }
    : { fit_narrative: null, fit_narrative_fit_score: null, fit_narrative_model: model, fit_narrative_at: nowIso };
}

async function applyFitPatch(db: DB, cardId: string, patch: FitNarrativePatch): Promise<boolean> {
  const { error } = await db.from("review_cards").update(patch).eq("id", cardId);
  if (error) {
    console.error(`[fit-analysis] card ${cardId}: fit_narrative write failed: ${error.message}`);
    return false;
  }
  return true;
}

// ── Freshness / eligibility (pure) ───────────────────────────────────────────────────────────────────

// The row shape resolveFit + the freshness check read. A superset of QaOverrideRow plus the fit_narrative*
// columns and the engine-read fields the generator needs.
export interface FitPollRow {
  id: string;
  grant_id: string | null;
  client_id: string | null;
  fit_score: 1 | 2 | 3 | null;
  factor_scores: FactorScores | null;
  proposed_role: string | null;
  recommended_prime: string | null;
  why_this_org: string[] | null;
  reasoning_context: { role_assignment_logic?: string; [k: string]: unknown } | null;
  qa_fit_score?: number | null;
  qa_factor_scores?: FactorScores | null;
  qa_status?: string | null;
  qa_engine_fit_score?: number | null;
  fit_narrative?: string | null;
  fit_narrative_fit_score?: number | null;
}

// The DISPLAYED (QA-coalesced) score, via the ONE resolver — so the drain, the freshness snapshot, and the
// render read the same number.
export function displayedFitOf(row: FitPollRow): 1 | 2 | 3 | null {
  return resolveFit(row).fitScore;
}

// Does this card need a fresh fit_narrative? Eligible = displayed is a go/marginal (2/3) AND the stored
// narrative is missing OR its snapshot no longer matches the displayed score (an engine re-score or a QA
// apply/clear moved it). A displayed-1 (no-go / applied demote) is never eligible — qa_narrative owns it.
export function fitNarrativeStale(row: FitPollRow): boolean {
  const displayed = displayedFitOf(row);
  if (displayed !== 2 && displayed !== 3) return false;
  const hasText = typeof row.fit_narrative === "string" && row.fit_narrative.trim().length > 0;
  // A stamped-but-null narrative (fit_narrative null, snapshot null, but generated) is NOT stale on its own —
  // it means the model couldn't write one cleanly; the stamp (fit_narrative_at) keeps the poller from looping
  // on it. We treat "missing snapshot" as stale ONLY when there is no stamp at all — handled by the poll query
  // (it selects fit_narrative_at and skips stamped cards for one direction). Here: eligible iff no fresh text.
  return !(hasText && row.fit_narrative_fit_score === displayed);
}

// ── Orchestration: poll for stale go/marginal cards, generate, write ─────────────────────────────────

export interface FitAnalysisOptions {
  generate?: FitGenerate;
  now?: () => number;
  batch?: number;
  concurrency?: number;
  estCostUsd?: number;
  dailyCapUsd?: number;
}

export interface FitAnalysisResult {
  scanned: number;
  eligible: number;
  generated: number; // wrote a real narrative
  cleared: number; // stamped null (model/guard shortfall) — no text, but marked so we don't loop
  skippedClosed: number; // deadline already passed → no Opus spend
  failed: number; // write error
  capReached: boolean;
  spentTodayUsd: number;
}

function startOfUtcDayIso(nowMs: number): string {
  const d = new Date(nowMs);
  d.setUTCHours(0, 0, 0, 0);
  return d.toISOString();
}

// The columns the poll reads off each candidate card — the engine read, the QA override layer (for the
// coalesced score), and the fit_narrative* columns (for freshness). fit_narrative_at is selected so a card
// generated THIS pass is not re-scanned, and a stamped-null card (model couldn't write) is not looped on.
const POLL_COLUMNS =
  "id, grant_id, client_id, fit_score, factor_scores, proposed_role, recommended_prime, why_this_org, reasoning_context, qa_fit_score, qa_factor_scores, qa_status, qa_engine_fit_score, fit_narrative, fit_narrative_fit_score, fit_narrative_at";

type PollRowWithStamp = FitPollRow & { fit_narrative_at?: string | null };

// Count today's (UTC) generations off the fit_narrative_at column itself — the ledger IS the column, so no
// separate run-log table. A card regenerated twice today counts once (the stamp is overwritten); fine for a
// safety ceiling. × the flat estimate = today's spend.
async function generatedTodayCount(db: DB, nowMs: number): Promise<number> {
  const { count } = await db
    .from("review_cards")
    .select("id", { count: "exact", head: true })
    .gte("fit_narrative_at", startOfUtcDayIso(nowMs));
  return count ?? 0;
}

// Run one invocation: poll for stale go/marginal client cards (paging past fresh ones), generate for a
// cost-bounded batch, write each. NO queue table — a failed generation just leaves the card on the engine
// paragraph and is retried next cron (idempotent, self-healing). Gated by FIT_ANALYSIS_ENABLED.
export async function runFitAnalysis(db: DB, opts: FitAnalysisOptions = {}): Promise<FitAnalysisResult> {
  const empty: FitAnalysisResult = {
    scanned: 0, eligible: 0, generated: 0, cleared: 0, skippedClosed: 0, failed: 0, capReached: false, spentTodayUsd: 0,
  };
  if (!fitAnalysisEnabled()) return empty;

  const now = opts.now ?? (() => Date.now());
  const generate = opts.generate ?? realGenerate;
  const batch = opts.batch ?? FIT_ANALYSIS_BATCH;
  const concurrency = opts.concurrency ?? FIT_ANALYSIS_CONCURRENCY;
  const estCost = opts.estCostUsd ?? FIT_EST_COST_PER_CARD_USD;
  const dailyCap = opts.dailyCapUsd ?? FIT_ANALYSIS_DAILY_CAP_USD;

  const result: FitAnalysisResult = { ...empty };

  // Daily cost ceiling — stop if today's estimated spend already covers this batch's minimum.
  const spent = (await generatedTodayCount(db, now())) * estCost;
  result.spentTodayUsd = spent;
  const budgetLeft = dailyCap - spent;
  if (budgetLeft < estCost) return { ...result, capReached: true };
  const affordable = Math.floor(budgetLeft / estCost);
  const target = Math.max(0, Math.min(batch, affordable));
  if (target === 0) return { ...result, capReached: true };

  // Paused clients (match_active=false, migration 0091) drop out of the narrative pass the same way they
  // drop out of matching + auto-QA — a not-yet-onboarded client's cards never spend Opus.
  const { data: pausedRows } = await db.from("clients").select("id").eq("match_active", false).returns<{ id: string }[]>();
  const paused = new Set((pausedRows ?? []).map((r) => r.id));

  // Poll: page oldest-first through pending client cards, collecting stale go/marginal ones up to `target`.
  // Paging past fresh cards (rather than post-filtering one window) keeps a large fresh prefix from starving
  // newer stale cards — the QA poller's pattern.
  const eligible: FitPollRow[] = [];
  for (let page = 0; page < FIT_POLL_MAX_PAGES && eligible.length < target; page++) {
    const { data: rows } = await db
      .from("review_cards")
      .select(POLL_COLUMNS)
      .eq("decision", "pending")
      .is("sme_released_at", null)
      .eq("card_type", "client")
      .not("client_id", "is", null)
      .not("grant_id", "is", null)
      .order("created_at", { ascending: true })
      .range(page * FIT_POLL_PAGE_SIZE, page * FIT_POLL_PAGE_SIZE + FIT_POLL_PAGE_SIZE - 1)
      .returns<PollRowWithStamp[]>();
    if (!rows || rows.length === 0) break;
    result.scanned += rows.length;
    for (const row of rows) {
      if (row.client_id && paused.has(row.client_id)) continue;
      if (!fitNarrativeStale(row)) continue;
      // A stamped-null card (model couldn't write a clean narrative last time) carries fit_narrative_at but
      // no text; skip it so the poller doesn't loop and re-spend on it every cycle. It refreshes when its
      // displayed score changes (fit_narrative_fit_score won't match → but it's null, so we key on the stamp):
      // only re-attempt when there is NO stamp, or the snapshot is set and stale (a real prior narrative).
      const stampedNullNoChange =
        !!row.fit_narrative_at && !row.fit_narrative?.trim() && row.fit_narrative_fit_score == null;
      if (stampedNullNoChange) continue;
      eligible.push(row);
      if (eligible.length >= target) break;
    }
    if (rows.length < FIT_POLL_PAGE_SIZE) break;
  }
  result.eligible = eligible.length;
  if (eligible.length === 0) return result;

  // Fetch the grant + client for each eligible card, generate, write. Concurrency-bounded.
  const nowIso = new Date(now()).toISOString();
  for (let i = 0; i < eligible.length; i += concurrency) {
    const chunk = eligible.slice(i, i + concurrency);
    const outcomes = await Promise.all(
      chunk.map((row) => processOne(db, row, { now: nowIso, generate, estCost })),
    );
    for (const o of outcomes) {
      if (o === "generated") result.generated += 1;
      else if (o === "cleared") result.cleared += 1;
      else if (o === "closed") result.skippedClosed += 1;
      else if (o === "failed") result.failed += 1;
    }
  }
  return result;
}

type ProcessOutcome = "generated" | "cleared" | "closed" | "failed" | "skipped";

async function processOne(
  db: DB,
  row: FitPollRow,
  deps: { now: string; generate: FitGenerate; estCost: number },
): Promise<ProcessOutcome> {
  if (!row.grant_id || !row.client_id) return "skipped";
  const [{ data: grant }, { data: client }] = await Promise.all([
    db
      .from("grants")
      .select(
        "title, funder, description_brief, description, eligible_entity_types, program_type, geographic_eligibility, submission_deadline, program_award_summary",
      )
      .eq("id", row.grant_id)
      .maybeSingle<FitGrant & { program_award_summary: ProgramAwardSummary | null }>(),
    db.from("clients").select("*").eq("id", row.client_id).maybeSingle<Client>(),
  ]);
  if (!grant || !client) return "skipped";
  // Recheck the pause at generate time (a client paused after the poll must not still spend Opus).
  if (client.match_active === false) return "skipped";
  // Skip a card whose deadline has strictly passed — the affirmative narrative is suppressed under the
  // staff no-go lead anyway, and closed cards are auto-archived by the closed-sweep cron; save the spend.
  if (deadlineDaysLeft(grant.submission_deadline) !== null && (deadlineDaysLeft(grant.submission_deadline) as number) < 0) {
    return "closed";
  }

  const displayed = displayedFitOf(row);
  if (displayed !== 2 && displayed !== 3) return "skipped"; // moved out of go/marginal since the poll
  const band = displayed === 3 ? "strong" : "conditional";

  const card: FitCard = {
    fit_score: row.fit_score,
    proposed_role: row.proposed_role,
    recommended_prime: row.recommended_prime,
    why_this_org: row.why_this_org,
    reasoning_context: row.reasoning_context,
  };

  let narrative: string | null;
  try {
    narrative = await generateFitNarrative(card, grant, client, band, { generate: deps.generate });
  } catch (err) {
    // A model error is non-fatal: leave the card on the engine paragraph (no stamp) → retried next cron.
    console.error(`[fit-analysis] card ${row.id}: generation failed: ${err instanceof Error ? err.message : String(err)}`);
    return "failed";
  }

  const patch = buildFitPatch(narrative, displayed, FIT_ANALYSIS_MODEL, deps.now);
  const ok = await applyFitPatch(db, row.id, patch);
  if (!ok) return "failed";
  return narrative ? "generated" : "cleared";
}

// On-demand generation for ONE card (the admin route + look-before-merge). Resolves the current pending
// client card, generates, writes — same path as the drain, but for a single named card and ignoring the
// daily cap (a human asked for this one). Returns what happened.
export async function runFitAnalysisForCard(
  db: DB,
  cardId: string,
  opts: { generate?: FitGenerate; now?: () => number } = {},
): Promise<{ outcome: ProcessOutcome; narrative: string | null }> {
  const now = opts.now ?? (() => Date.now());
  const generate = opts.generate ?? realGenerate;
  const { data: row } = await db
    .from("review_cards")
    .select(POLL_COLUMNS)
    .eq("id", cardId)
    .eq("card_type", "client")
    .maybeSingle<FitPollRow>();
  if (!row) return { outcome: "skipped", narrative: null };
  const displayed = displayedFitOf(row);
  if (displayed !== 2 && displayed !== 3) return { outcome: "skipped", narrative: null };
  const outcome = await processOne(db, row, { now: new Date(now()).toISOString(), generate, estCost: FIT_EST_COST_PER_CARD_USD });
  // Read the stored narrative back for the caller (the admin route surfaces it for the look-before-merge).
  if (outcome === "generated") {
    const { data: after } = await db.from("review_cards").select("fit_narrative").eq("id", cardId).maybeSingle<{ fit_narrative: string | null }>();
    return { outcome, narrative: after?.fit_narrative ?? null };
  }
  return { outcome, narrative: null };
}
