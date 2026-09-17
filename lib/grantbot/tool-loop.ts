// GrantBot's bounded tool-use loop — TOOL-AGNOSTIC. Web-fetch (Brick B) was its first tool; document
// artifacts (Brick 1a) are the second. The loop knows nothing about either: it takes a server-assembled
// tool set (via callModel) and a dispatch closure, runs the model, and for each tool_use hands it to
// dispatch and feeds the result back — bounded by a round cap and a wall-clock deadline.
//
// PURE-TESTABLE, and this is where the load-bearing property lives: callModel and dispatch are INJECTED
// seams, so the bounds and — most importantly — the FLAG-OFF equivalence are unit-tested without a live
// model, a network, or a database. `toolsEnabled=false` is the flag-off path: the loop makes exactly one
// call with ToolMode "off" (no `tools`/`tool_choice` keys), which is what proves off == today. That
// holds for EVERY capability's flag: when all tool flags are off, toolsEnabled is false and the request
// is byte-identical to the pre-tools single-shot call.
//
// Not marked "server-only": its only real caller is turn.ts (server-only), and dispatch owns all I/O.

import type { TurnUsage } from "@/lib/grantbot/store";

// At most this many rounds of tool calls per turn; the (round+1)th call is made in ToolMode "none"
// (tools still present, tool_choice:{type:"none"}) to force a final text answer — NOT with tools
// dropped, which would 400 against a tool_use history.
export const MAX_TOOL_ROUNDS = 2;
// The per-client GrantBot turn overrides the default to 3. A grounded who-wins answer wants a national
// lookup_program_awards call, an in-state precedent call, AND a synthesis round — three model calls
// that a 2-round budget truncated mid-thought ("let me also check…"), the data-tools eval's run-1
// failure. Still bounded by TURN_DEADLINE_MS, so the extra round can never run past the route budget.
export const PER_CLIENT_MAX_TOOL_ROUNDS = 3;
// Wall-clock budget for the whole turn's model calls + tool executions, inside the route's
// maxDuration=300s. The per-call timeout is clamped to what remains, so the first call is the full
// budget when nothing has elapsed — which is part of what keeps flag-off byte-identical.
export const TURN_DEADLINE_MS = 220_000;

// Per-DISPATCH wall-clock bound, opt-in via runToolLoop({ dispatchTimeoutMs }). The loop's deadline is
// only checked BETWEEN rounds, so a single slow tool execution (e.g. a fetched PDF whose parse yields
// slowly) is not interrupted by the round-level check. This bounds one dispatch: when it expires the
// loop feeds a typed "tool did not finish" tool_result and proceeds to the final answer, so a slow tool
// can never make the turn hang returning nothing. Belt-and-suspenders to each tool's OWN internal bound
// (the fetch timeout + PDF_PARSE_TIMEOUT_MS, the data-tools' 15s). Callers that omit dispatchTimeoutMs
// (intel, the tests) are byte-identical — the wrap is skipped entirely. Generous so a legitimate fetch
// + parse or a national+in-state data lookup completes well within it.
export const DISPATCH_TIMEOUT_MS = 45_000;

// How the call treats tools:
//   off  -> no `tools` parameter at all. The all-flags-off path is always this, which is what makes it
//           byte-identical to the pre-tools single-shot call.
//   auto -> tools offered; the model may call one. A normal tool round.
//   none -> tools still PRESENT (so a tool_use/tool_result history stays valid and the API does not
//           400), but tool_choice forbids another call. The forced FINAL answer, at the round cap or
//           once the wall-clock deadline is spent.
export type ToolMode = "off" | "auto" | "none";

export interface ModelTurn {
  text: string;
  // A tool_use as the loop sees it: name + raw input. The dispatch pulls what each tool needs.
  toolUses: { id: string; name: string; input: unknown }[];
  stopReason: string | null;
  usage: TurnUsage | null;
  // The raw assistant content blocks, pushed back verbatim when continuing a tool exchange.
  rawContent: unknown;
}

export type CallModel = (opts: { messages: unknown[]; tools: ToolMode; remainingMs: number }) => Promise<ModelTurn>;

// Run one tool_use: return the tool_result text the model sees. Dispatch OWNS any audit side-effects
// (it pushes to caller-held sinks as it runs), so a mid-loop throw on a LATER round still leaves the
// audit of tools already executed visible to the caller. The loop itself holds no audit state.
export type ToolDispatch = (toolUse: { id: string; name: string; input: unknown }) => Promise<{ resultText: string }>;

function addUsage(a: TurnUsage | null, b: TurnUsage | null): TurnUsage | null {
  if (!b) return a;
  if (!a) return b;
  const sum = (x: number | null, y: number | null) => (x == null && y == null ? null : (x ?? 0) + (y ?? 0));
  return {
    input_tokens: sum(a.input_tokens, b.input_tokens),
    output_tokens: sum(a.output_tokens, b.output_tokens),
    cache_read_input_tokens: sum(a.cache_read_input_tokens, b.cache_read_input_tokens),
    cache_creation_input_tokens: sum(a.cache_creation_input_tokens, b.cache_creation_input_tokens),
  };
}

export async function runToolLoop(opts: {
  messages: unknown[];
  toolsEnabled: boolean;
  callModel: CallModel;
  dispatch: ToolDispatch;
  now: () => number;
  deadlineMs?: number;
  maxToolRounds?: number;
  // Opt-in per-dispatch bound (see DISPATCH_TIMEOUT_MS). Omitted (intel, tests) = no wrap, byte-identical.
  dispatchTimeoutMs?: number;
  // When set, ONLY these tools' dispatches may be abandoned on the dispatch timeout; every other tool
  // runs to completion. This is the safety boundary for the timeout: a WRITE tool (create_artifact /
  // edit_artifact) must NEVER be abandoned, because the underlying write can still commit AFTER the model
  // was told it was skipped — inserting a document/version the model believes does not exist, and letting
  // a retry duplicate it (Codex #586, P1). Only read-only, hang-prone dispatches (the .gov fetch) belong
  // here; a read that is abandoned merely discards its result. Absent = bound all (the loop's own tests,
  // whose only dispatched tool is read-only).
  boundableDispatchTools?: ReadonlySet<string>;
}): Promise<{ text: string; usage: TurnUsage | null; stopReason: string | null }> {
  const deadlineMs = opts.deadlineMs ?? TURN_DEADLINE_MS;
  const maxToolRounds = opts.maxToolRounds ?? MAX_TOOL_ROUNDS;
  const start = opts.now();
  const working = [...opts.messages];

  // Run one dispatch, bounded by dispatchTimeoutMs when set. On expiry it RESOLVES (never rejects) with a
  // typed tool_result so the loop continues to a final answer rather than hanging on the tool; the real
  // dispatch keeps running in the background (its audit side-effects still fire) but its result is
  // ignored. Without dispatchTimeoutMs this is exactly `opts.dispatch(tu)` — the byte-identical path.
  const dispatchBounded = (tu: { id: string; name: string; input: unknown }): Promise<{ resultText: string }> => {
    if (opts.dispatchTimeoutMs == null) return opts.dispatch(tu);
    // A tool not in the boundable set (when a set is given) runs to completion — never abandoned. This is
    // what keeps a WRITE dispatch from being silently skipped-then-committed (Codex #586).
    if (opts.boundableDispatchTools && !opts.boundableDispatchTools.has(tu.name)) return opts.dispatch(tu);
    const budget = Math.min(opts.dispatchTimeoutMs, Math.max(deadlineMs - (opts.now() - start), 1_000));
    let timer: ReturnType<typeof setTimeout>;
    const timeout = new Promise<{ resultText: string }>((resolve) => {
      timer = setTimeout(
        () =>
          resolve({
            resultText: `The tool "${tu.name}" did not finish within its time budget and was skipped. Do not wait for it — answer from what you already have, or tell the staffer to check the official source.`,
          }),
        budget,
      );
    });
    (timer! as unknown as { unref?: () => void })?.unref?.();
    return Promise.race([opts.dispatch(tu), timeout]).finally(() => clearTimeout(timer));
  };

  let usage: TurnUsage | null = null;
  let stopReason: string | null = null;
  let text = "";

  for (let round = 0; ; round++) {
    const remainingMs = deadlineMs - (opts.now() - start);
    // OFF whenever no tool capability is enabled -> callModel is invoked exactly once with no tools
    // (today). AUTO under the round cap with time left. Otherwise NONE: the forced final answer, tools
    // still present so the tool_use history stays valid.
    const toolMode: ToolMode = !opts.toolsEnabled
      ? "off"
      : round < maxToolRounds && remainingMs > 0
        ? "auto"
        : "none";

    const res = await opts.callModel({ messages: working, tools: toolMode, remainingMs });
    usage = addUsage(usage, res.usage);
    stopReason = res.stopReason;
    text = res.text;

    if (toolMode === "auto" && res.stopReason === "tool_use" && res.toolUses.length > 0) {
      // Continue the exchange: the assistant's tool_use turn, then a user turn of tool_results. In
      // production the real callModel sets disable_parallel_tool_use, so toolUses holds at most one
      // entry per round; the loop still iterates for correctness, and every tool_use gets a matching
      // tool_result either way.
      working.push({ role: "assistant", content: res.rawContent });
      const toolResults: unknown[] = [];
      for (const tu of res.toolUses) {
        const { resultText } = await dispatchBounded(tu);
        toolResults.push({ type: "tool_result", tool_use_id: tu.id, content: resultText });
      }
      working.push({ role: "user", content: toolResults });
      continue;
    }

    // A SERVER-side tool (e.g. web_search) can pause a long turn with stop_reason "pause_turn": the
    // model's partial turn is returned and the request must be RE-ISSUED to resume it — with NO
    // tool_result added, because the server already ran the tool inline. Without this the loop would
    // break here and return a SILENTLY TRUNCATED answer (the documented server-tool pitfall). Only
    // under "auto": "none"/"off" set tool_choice so no server tool can run, so no pause can occur.
    // Bounded by the same round cap + deadline as tool rounds, so a pathological pause→pause cannot
    // loop forever. Inert for a client-tool-only caller (GrantBot never emits pause_turn).
    if (toolMode === "auto" && res.stopReason === "pause_turn") {
      working.push({ role: "assistant", content: res.rawContent });
      continue;
    }

    break;
  }

  return { text, usage, stopReason };
}
