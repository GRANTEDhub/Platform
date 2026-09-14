import { describe, it, expect } from "vitest";
import type Anthropic from "@anthropic-ai/sdk";
import { getAnthropicClient, OPUS_MODEL } from "@/lib/anthropic";
import { assembleSystem, buildSystemPrompt } from "./prompt";
import type { ContextPack } from "./context-pack";
import { runToolLoop, TURN_DEADLINE_MS, type CallModel, type ToolDispatch } from "./tool-loop";
import {
  executeDataTool,
  DATA_TOOLS_INSTRUCTION_BLOCK,
  PROGRAM_AWARDS_TOOL,
  ORG_HISTORY_TOOL,
  SAM_ENTITY_TOOL,
  PROGRAM_AWARDS_TOOL_NAME,
  type DataToolDeps,
} from "./data-tools";
import type { ProgramAwardee, USASpendingResult } from "@/lib/grants/usaspending";
import type { SamEntity } from "@/lib/sam/client";

// ── GrantBot federal-data-tools eval — the flip gate for GRANTBOT_DATA_TOOLS_ENABLED ────────────────
//
// MODEL-IN-THE-LOOP + THE REAL TOOL LOOP. NOT a unit test; MUST NOT run in the normal suite or the
// sandbox — it makes real (paid) calls to the deployed per-client model (Opus 5) and drives the actual
// runToolLoop. Skipped unless RUN_DATA_TOOLS_EVAL=1 AND ANTHROPIC_API_KEY is present:
//
//   RUN_DATA_TOOLS_EVAL=1 DATA_TOOLS_EVAL_RUNS=3 ANTHROPIC_API_KEY=... \
//   npx vitest run lib/grantbot/data-tools.eval.test.ts
//
// WHY IT EXISTS. It is the trust gate that the data tools actually FIX the failure that motivated them:
// the live MS County repro where "what type of applicant usually wins CFDA 20.284?" stalled on a
// dangling "let me pull the prior award list" with no answer, because the bot had no way to see who
// won. This proves, on the real model + the real loop, that GrantBot now (a) CALLS lookup_program_awards
// and characterizes the winner TYPE off the actual list, and (b) stays honest when a lookup is empty —
// reporting the gap, never fabricating winners.
//
// THE DATA IS FAKED, THE MODEL AND LOOP ARE REAL. executeDataTool's clients are INJECTED here with a
// deterministic winner list, so the eval isolates the behaviour it gates — does the model reach for the
// tool and reason from its result — without depending on USASpending being up or returning data for a
// given CFDA on a given day. Same discipline as the intel-review eval's seeded fixtures.
//
// Majority-of-runs (expect.soft), because a single model run varies. Read the console.log'd answers +
// tool-call traces when interpreting a soft miss.

const RUN = process.env.RUN_DATA_TOOLS_EVAL === "1" && !!process.env.ANTHROPIC_API_KEY;
const RUNS = Math.max(1, Number(process.env.DATA_TOOLS_EVAL_RUNS) || 3);

const majority = (bools: boolean[]) => bools.filter(Boolean).length > bools.length / 2;

function makePack(over: Partial<ContextPack> = {}): ContextPack {
  return {
    orgName: "Mississippi County",
    generatedAt: "2026-09-14T00:00:00Z",
    generatedBy: "data-tools-eval",
    clientRowTouchedAt: "2026-09-01T00:00:00Z",
    actorRole: "staff",
    items: [
      { section: "organization", label: "Legal name", body: "Mississippi County, Arkansas", source: "clients.name", provenance: "platform", capturedAt: "2026-09-01T00:00:00Z" },
      { section: "organization", label: "Organization type", body: "local_government (county)", source: "clients.org_type", provenance: "platform", capturedAt: null },
      { section: "client-stated", label: "Focus areas", body: "Rural economic development, county roads and infrastructure, agriculture.", source: "intake_form", provenance: "client-stated", capturedAt: "2026-06-01T00:00:00Z" },
    ],
    gaps: ["No matched grants recorded for this client yet."],
    omitted: ["Billing, invoices, and commercial terms are never included in this context."],
    stats: { documents: 0, matches: 0, detailedMatches: 0, concepts: 0, drafts: 0, alerts: 0, events: 0, changes: 0, dropped: [] },
    ...over,
  };
}

// A winner list that reads unambiguously as STATE TRANSPORTATION AGENCIES — the true archetype for a
// PROTECT (FHWA, CFDA 20.284) program. The model should characterize this as state DOTs / state
// agencies and say a county is at best a sub-applicant.
const PROTECT_WINNERS: ProgramAwardee[] = [
  { name: "California Department of Transportation", state: "CA", award_count: 4, total_awarded: 48_000_000, agencies: ["Department of Transportation"], recipient_id: "r1", most_recent_year: "2025" },
  { name: "Washington State Department of Transportation", state: "WA", award_count: 3, total_awarded: 31_000_000, agencies: ["Department of Transportation"], recipient_id: "r2", most_recent_year: "2025" },
  { name: "New York State Department of Transportation", state: "NY", award_count: 2, total_awarded: 27_000_000, agencies: ["Department of Transportation"], recipient_id: "r3", most_recent_year: "2024" },
  { name: "Texas Department of Transportation", state: "TX", award_count: 3, total_awarded: 40_000_000, agencies: ["Department of Transportation"], recipient_id: "r4", most_recent_year: "2025" },
];

function fakeDeps(over: Partial<DataToolDeps> = {}): DataToolDeps {
  const emptyHistory: USASpendingResult = {
    has_federal_grant_history: false, award_count: 0, total_awarded: 0, agencies: [], most_recent: null, search_term: "", verified: true,
  };
  return {
    findProgramAwardees: async () => [],
    checkPastPerformance: async (name) => ({ ...emptyHistory, search_term: name }),
    lookupByUei: async () => null,
    searchByNameState: async () => [] as SamEntity[],
    ...over,
  };
}

// One GrantBot turn through the REAL loop with tools present and data clients injected. Mirrors turn.ts's
// callModel + dispatch (Opus 5, thinking disabled, parallel tool use off), minus the DB/pack machinery.
async function callGrantBotWithTools(
  pack: ContextPack,
  userText: string,
  deps: DataToolDeps,
): Promise<{ text: string; toolCalls: { name: string; input: unknown }[] }> {
  const prompt = buildSystemPrompt({ pack });
  const system = assembleSystem(prompt, [DATA_TOOLS_INSTRUCTION_BLOCK]);
  const anthropic = getAnthropicClient();
  const toolSet = [PROGRAM_AWARDS_TOOL, ORG_HISTORY_TOOL, SAM_ENTITY_TOOL] as unknown as Anthropic.Tool[];
  const toolCalls: { name: string; input: unknown }[] = [];

  const callModel: CallModel = async ({ messages, tools }) => {
    const res = await anthropic.messages.create({
      model: OPUS_MODEL,
      thinking: { type: "disabled" as const },
      max_tokens: 1500,
      system,
      messages: messages as Anthropic.MessageParam[],
      ...(tools === "off" ? {} : { tools: toolSet }),
      ...(tools === "auto" ? { tool_choice: { type: "auto" as const, disable_parallel_tool_use: true } } : {}),
      ...(tools === "none" ? { tool_choice: { type: "none" as const } } : {}),
    });
    const text = res.content.map((b) => (b.type === "text" ? b.text : "")).filter(Boolean).join("\n").trim();
    const toolUses = res.content
      .filter((b) => b.type === "tool_use")
      .map((b) => { const tb = b as { id: string; name: string; input?: unknown }; return { id: tb.id, name: tb.name, input: tb.input }; });
    return { text, toolUses, stopReason: res.stop_reason ?? null, usage: null, rawContent: res.content };
  };

  const dispatch: ToolDispatch = async (tu) => {
    toolCalls.push({ name: tu.name, input: tu.input });
    const { resultText } = await executeDataTool({ name: tu.name, input: tu.input }, { deps });
    return { resultText };
  };

  const loop = await runToolLoop({
    messages: [{ role: "user", content: userText }],
    toolsEnabled: true,
    callModel,
    dispatch,
    now: () => Date.now(),
    deadlineMs: TURN_DEADLINE_MS,
  });
  return { text: loop.text, toolCalls };
}

describe.skipIf(!RUN)("GrantBot data-tools eval (live model + real loop)", () => {
  it(
    "1. who-wins (the PROTECT repro) → CALLS lookup_program_awards and characterizes the winner TYPE, no stall",
    async () => {
      // The literal MS County failure: this used to end on a dangling "let me pull the prior award list"
      // with no answer. With the tool present the model must actually call it and read the archetype off
      // the real winners (state DOTs), and tell a county it's at best a sub-applicant — never force-fit.
      const userText =
        "Looking at this PROTECT grant (DOT Federal Highway Administration, CFDA 20.284): what type of applicant usually receives these grants? It says about 80 awards nationally.";
      const runs = await Promise.all(
        Array.from({ length: RUNS }, () => callGrantBotWithTools(makePack(), userText, fakeDeps({ findProgramAwardees: async () => PROTECT_WINNERS }))),
      );
      console.log(
        "[data-tools-eval] who-wins:\n" +
          runs.map((r, i) => `--- run ${i + 1} ---\ntools: ${r.toolCalls.map((t) => t.name).join(", ") || "(none)"}\n${r.text}`).join("\n\n"),
      );
      const calledAwards = runs.map((r) => r.toolCalls.some((t) => t.name === PROGRAM_AWARDS_TOOL_NAME));
      // The answer reads the TYPE off the winners: state DOTs / state transportation agencies.
      const characterized = runs.map((r) => /state|department of transportation|\bDOT\b|transportation agenc|state agenc/i.test(r.text));
      // The old failure was a DANGLING promise with no delivery. A compliant answer does not END on an
      // undelivered "let me pull/look up" — it either produced the read or reported the gap.
      const noStall = runs.map((r) => !/\blet me (?:pull|look|check|search|fetch|go)\b[^.]*$/i.test(r.text.trim()) && r.text.trim().length > 40);
      const compliant = calledAwards.map((c, i) => c && characterized[i] && noStall[i]);
      expect.soft(majority(calledAwards), "must CALL lookup_program_awards for a who-wins question, not answer from memory or stall").toBe(true);
      expect.soft(majority(characterized), "must characterize the winner TYPE (state DOTs / state transportation agencies) from the returned list").toBe(true);
      expect.soft(majority(noStall), "must not end on a dangling 'let me pull…' — the exact live failure this fixes").toBe(true);
      expect.soft(majority(compliant), "the SAME answer must call the tool, characterize the winners, and not stall").toBe(true);
    },
    RUNS * 180_000,
  );

  it(
    "2. empty program → reports the GAP, never fabricates a winner archetype",
    async () => {
      // Honesty under the tool: when the lookup returns nothing, the answer must say so (no awards found /
      // not in USASpending / can't confirm who wins) and must NOT invent a confident archetype as fact.
      const userText =
        "For this program, CFDA 99.999, what type of organization usually wins it? Give me the archetype.";
      const runs = await Promise.all(
        Array.from({ length: RUNS }, () => callGrantBotWithTools(makePack(), userText, fakeDeps())), // findProgramAwardees → []
      );
      console.log(
        "[data-tools-eval] empty-program:\n" +
          runs.map((r, i) => `--- run ${i + 1} ---\ntools: ${r.toolCalls.map((t) => t.name).join(", ") || "(none)"}\n${r.text}`).join("\n\n"),
      );
      const reportsGap = runs.map((r) =>
        /no (?:federal )?awards|not (?:yet )?(?:posted|found|in usaspending|available)|could ?n(?:'|o)?t (?:find|confirm|retrieve)|couldn't find|no (?:data|record)|don(?:'|o)?t have|unable to (?:find|confirm)|new (?:or )?forecast|no winners/i.test(r.text),
      );
      // Must not present a confident archetype it doesn't have. If it names a specific winner-type as fact
      // WITHOUT any gap language, that's the fabrication this guards.
      const compliant = reportsGap;
      expect.soft(majority(reportsGap), "an empty lookup must be reported as a gap, not backfilled with a memory archetype").toBe(true);
      expect.soft(majority(compliant), "the SAME answer must report the gap rather than assert an unverified archetype").toBe(true);
    },
    RUNS * 180_000,
  );
});
