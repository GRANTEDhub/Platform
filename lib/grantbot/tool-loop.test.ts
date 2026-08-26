import { describe, it, expect } from "vitest";
import { runToolLoop, type CallModel, type ModelTurn, type ToolDispatch } from "./tool-loop";
import type { TurnUsage } from "./store";

const USAGE: TurnUsage = { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };

function turn(over: Partial<ModelTurn> = {}): ModelTurn {
  return { text: "", toolUses: [], stopReason: "end_turn", usage: USAGE, rawContent: [], ...over };
}

// A tool_use as the model now emits it to the loop: {id, name, input}.
function toolUse(id: string, url: string) {
  return { id, name: "fetch_grant_source", input: { url } };
}

describe("runToolLoop", () => {
  function recorder(script: ModelTurn[]) {
    // Snapshot messagesLen at call time: runToolLoop mutates one `working` array in place.
    const calls: { tools: "off" | "auto" | "none"; remainingMs: number; messagesLen: number }[] = [];
    let i = 0;
    const callModel: CallModel = async ({ messages, tools, remainingMs }) => {
      calls.push({ tools, remainingMs, messagesLen: messages.length });
      return script[Math.min(i++, script.length - 1)];
    };
    return { callModel, calls };
  }

  it("TOOLS OFF (all flags off): exactly one model call, tools 'off', no dispatch (== today)", async () => {
    const { callModel, calls } = recorder([turn({ text: "hi" })]);
    const dispatch: ToolDispatch = async () => {
      throw new Error("must not dispatch when no tool capability is enabled");
    };
    const r = await runToolLoop({
      messages: [{ role: "user", content: "q" }],
      toolsEnabled: false,
      callModel,
      dispatch,
      now: () => 0,
    });
    expect(calls).toHaveLength(1);
    expect(calls[0].tools).toBe("off");
    expect(r.text).toBe("hi");
    expect(r.usage).toEqual(USAGE);
    expect(r.stopReason).toBe("end_turn");
  });

  it("TOOLS ON: dispatches once (with name+input), feeds the result back, then answers", async () => {
    const { callModel, calls } = recorder([
      turn({ toolUses: [toolUse("t1", "https://grants.gov/x")], stopReason: "tool_use", rawContent: [{ type: "tool_use", id: "t1" }] }),
      turn({ text: "answer" }),
    ]);
    const seen: { id: string; name: string; input: unknown }[] = [];
    const dispatch: ToolDispatch = async (tu) => {
      seen.push(tu);
      return { resultText: "FRAMED" };
    };
    const r = await runToolLoop({ messages: [{ role: "user", content: "q" }], toolsEnabled: true, callModel, dispatch, now: () => 0 });
    expect(seen).toHaveLength(1);
    expect(seen[0].name).toBe("fetch_grant_source");
    expect(seen[0].input).toEqual({ url: "https://grants.gov/x" });
    expect(calls.map((c) => c.tools)).toEqual(["auto", "auto"]);
    expect(r.text).toBe("answer");
    // The second call carries the appended assistant tool_use turn + user tool_result turn.
    expect(calls[1].messagesLen).toBe(calls[0].messagesLen + 2);
    expect(r.usage?.input_tokens).toBe(20);
  });

  it("at the round cap the forced-final call is 'none' (tools present, not dropped) — regression for the 400", async () => {
    const { callModel, calls } = recorder([turn({ toolUses: [toolUse("t", "https://grants.gov/a")], stopReason: "tool_use" })]);
    let dispatched = 0;
    const dispatch: ToolDispatch = async () => {
      dispatched += 1;
      return { resultText: "F" };
    };
    await runToolLoop({ messages: [{ role: "user", content: "q" }], toolsEnabled: true, callModel, dispatch, now: () => 0, maxToolRounds: 2 });
    // round0 tool, round1 tool, round2 forced FINAL -> "none", NOT "off".
    expect(calls.map((c) => c.tools)).toEqual(["auto", "auto", "none"]);
    expect(calls.every((c) => c.tools !== "off")).toBe(true);
    expect(dispatched).toBe(2);
  });

  it("once the wall-clock deadline is spent the next call is the forced-final 'none'", async () => {
    let t = 0;
    const { callModel, calls } = recorder([turn({ toolUses: [toolUse("t", "https://grants.gov/a")], stopReason: "tool_use" })]);
    await runToolLoop({
      messages: [{ role: "user", content: "q" }],
      toolsEnabled: true,
      callModel: async (opts) => {
        const res = await callModel(opts);
        t = 1000; // blow the 500ms deadline after the first call
        return res;
      },
      dispatch: async () => ({ resultText: "F" }),
      now: () => t,
      deadlineMs: 500,
      maxToolRounds: 5,
    });
    expect(calls.map((c) => c.tools)).toEqual(["auto", "none"]);
  });

  it("dispatch side-effects (audit sink) survive a later round throwing", async () => {
    // The loop does not catch; dispatch pushes to a caller-held sink AS IT RUNS, so a throw on a
    // later round still leaves the audit of tools already executed visible. Same property the turn
    // route relies on to record a partial audit on a failed turn.
    const sink: string[] = [];
    let call = 0;
    const callModel: CallModel = async () => {
      call += 1;
      if (call === 1) return turn({ toolUses: [toolUse("t1", "https://grants.gov/x")], stopReason: "tool_use" });
      throw new Error("boom on the second round");
    };
    const dispatch: ToolDispatch = async (tu) => {
      sink.push((tu.input as { url: string }).url);
      return { resultText: "F" };
    };
    await expect(
      runToolLoop({ messages: [{ role: "user", content: "q" }], toolsEnabled: true, callModel, dispatch, now: () => 0 }),
    ).rejects.toThrow("boom");
    expect(sink).toEqual(["https://grants.gov/x"]);
  });

  it("resumes a server-tool pause_turn: pushes the paused assistant turn back (no tool_result), then answers", async () => {
    // A server tool (web_search) ran inline and the turn PAUSED. The loop must re-issue to resume —
    // appending ONLY the paused assistant turn (no user tool_result, since there is no client tool to
    // answer), not break and return the empty partial. Without this the QA analysis is silently truncated.
    const { callModel, calls } = recorder([
      turn({ stopReason: "pause_turn", rawContent: [{ type: "server_tool_use", id: "s1", name: "web_search" }], text: "" }),
      turn({ text: "final answer" }),
    ]);
    let dispatched = 0;
    const dispatch: ToolDispatch = async () => {
      dispatched += 1;
      return { resultText: "F" };
    };
    const r = await runToolLoop({ messages: [{ role: "user", content: "q" }], toolsEnabled: true, callModel, dispatch, now: () => 0 });
    expect(dispatched).toBe(0); // server tool executed inline; the loop has nothing to dispatch
    expect(calls.map((c) => c.tools)).toEqual(["auto", "auto"]);
    // resume appends ONLY the assistant turn (+1), unlike a client-tool round which appends +2.
    expect(calls[1].messagesLen).toBe(calls[0].messagesLen + 1);
    expect(r.text).toBe("final answer");
  });

  it("a repeated pause_turn is bounded by the round cap (never loops forever)", async () => {
    // The model pauses on every auto round; the loop must stop at the cap and force a final 'none' call.
    const callModel: CallModel = async ({ tools }) =>
      tools === "none"
        ? turn({ text: "gave up cleanly" })
        : turn({ stopReason: "pause_turn", rawContent: [{ type: "server_tool_use" }] });
    const r = await runToolLoop({
      messages: [{ role: "user", content: "q" }],
      toolsEnabled: true,
      callModel,
      dispatch: async () => ({ resultText: "" }),
      now: () => 0,
      maxToolRounds: 2,
    });
    expect(r.text).toBe("gave up cleanly");
  });

  it("passes the full remaining budget on the first call", async () => {
    const { callModel, calls } = recorder([turn({ text: "hi" })]);
    await runToolLoop({
      messages: [{ role: "user", content: "q" }],
      toolsEnabled: false,
      callModel,
      dispatch: async () => ({ resultText: "" }),
      now: () => 0,
      deadlineMs: 220_000,
    });
    expect(calls[0].remainingMs).toBe(220_000);
  });
});
