import { describe, it, expect, afterEach } from "vitest";
import {
  frameFetchResult,
  executeWebFetch,
  runFetchLoop,
  grantbotWebFetchEnabled,
  FETCH_INSTRUCTION_BLOCK,
  WEB_FETCH_TOOL,
  type CallModel,
  type ModelTurn,
} from "./web-fetch";
import type { FetchResult } from "./fetch";
import type { TurnUsage } from "./store";

const USAGE: TurnUsage = { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };

function turn(over: Partial<ModelTurn> = {}): ModelTurn {
  return { text: "", toolUses: [], stopReason: "end_turn", usage: USAGE, rawContent: [], ...over };
}

describe("grantbotWebFetchEnabled", () => {
  const prev = process.env.GRANTBOT_WEB_FETCH_ENABLED;
  afterEach(() => {
    if (prev === undefined) delete process.env.GRANTBOT_WEB_FETCH_ENABLED;
    else process.env.GRANTBOT_WEB_FETCH_ENABLED = prev;
  });
  it("is off by default and off for anything but the literal 'true'", () => {
    delete process.env.GRANTBOT_WEB_FETCH_ENABLED;
    expect(grantbotWebFetchEnabled()).toBe(false);
    for (const v of ["1", "TRUE", "yes", "false", ""]) {
      process.env.GRANTBOT_WEB_FETCH_ENABLED = v;
      expect(grantbotWebFetchEnabled()).toBe(false);
    }
    process.env.GRANTBOT_WEB_FETCH_ENABLED = "true";
    expect(grantbotWebFetchEnabled()).toBe(true);
  });
});

describe("FETCH_INSTRUCTION_BLOCK", () => {
  it("is non-cacheable so it stays out of the shared cached prefix", () => {
    expect(FETCH_INSTRUCTION_BLOCK.cacheable).toBe(false);
    expect(FETCH_INSTRUCTION_BLOCK.kind).toBe("web-fetch");
  });
  it("names the one tool and the refuse-to-infer rule", () => {
    expect(FETCH_INSTRUCTION_BLOCK.text).toContain(WEB_FETCH_TOOL.name);
    expect(FETCH_INSTRUCTION_BLOCK.text).toMatch(/could not retrieve/i);
    expect(FETCH_INSTRUCTION_BLOCK.text).toMatch(/never infer|do not fetch idly|untrusted/i);
  });
});

describe("frameFetchResult", () => {
  it("wraps a successful fetch in the untrusted PASTED CONTENT frame and audits it", () => {
    const result: FetchResult = {
      ok: true,
      requestedUrl: "https://grants.gov/x",
      finalUrl: "https://grants.gov/final",
      contentType: "text/html",
      text: "NOFO body",
      truncated: false,
      fetchedAt: "2026-08-12T00:00:00Z",
    };
    const { resultText, audit } = frameFetchResult("https://grants.gov/x", result, () => "NOW");
    expect(resultText).toContain("PASTED CONTENT");
    expect(resultText).toContain("NOFO body");
    expect(resultText).toContain("fetched from https://grants.gov/final");
    expect(audit).toEqual({ url: "https://grants.gov/x", ok: true, finalUrl: "https://grants.gov/final", truncated: false, fetchedAt: "2026-08-12T00:00:00Z" });
  });
  it("notes truncation", () => {
    const result: FetchResult = { ok: true, requestedUrl: "u", finalUrl: "u", contentType: "text/html", text: "partial", truncated: true, fetchedAt: "T" };
    const { resultText, audit } = frameFetchResult("u", result, () => "NOW");
    expect(resultText).toMatch(/truncated/i);
    expect(audit.truncated).toBe(true);
  });
  it("turns a failure into a typed could-not-retrieve fact that forbids inferring", () => {
    const result: FetchResult = { ok: false, reason: "not_allowlisted", detail: "evil.com" };
    const { resultText, audit } = frameFetchResult("https://evil.com", result, () => "NOW");
    expect(resultText).toMatch(/COULD NOT RETRIEVE/);
    expect(resultText).toContain("not_allowlisted");
    expect(resultText).toMatch(/do not infer/i);
    expect(audit).toEqual({ url: "https://evil.com", ok: false, reason: "not_allowlisted", fetchedAt: "NOW" });
  });
});

describe("executeWebFetch", () => {
  it("refuses a missing url without fetching", async () => {
    let called = false;
    const { resultText, audit } = await executeWebFetch(undefined, {
      fetcher: async () => {
        called = true;
        return { ok: false, reason: "bad_url" };
      },
      now: () => "NOW",
    });
    expect(called).toBe(false);
    expect(audit).toEqual({ url: "", ok: false, reason: "no_url", fetchedAt: "NOW" });
    expect(resultText).toMatch(/no url/i);
  });
  it("fetches through the injected fetcher and frames the result", async () => {
    const { audit } = await executeWebFetch("https://grants.gov/x", {
      fetcher: async (u) => ({ ok: true, requestedUrl: u, finalUrl: u, contentType: "text/html", text: "body", truncated: false, fetchedAt: "T" }),
      now: () => "NOW",
    });
    expect(audit).toMatchObject({ url: "https://grants.gov/x", ok: true });
  });
});

describe("runFetchLoop", () => {
  // Record every callModel invocation so we can assert exactly what was sent.
  function recorder(script: ModelTurn[]) {
    // Snapshot messagesLen at call time: runFetchLoop mutates one `working` array in place, so
    // holding the reference would show every call the final length.
    const calls: { useTools: boolean; remainingMs: number; messagesLen: number }[] = [];
    let i = 0;
    const callModel: CallModel = async ({ messages, useTools, remainingMs }) => {
      calls.push({ useTools, remainingMs, messagesLen: messages.length });
      return script[Math.min(i++, script.length - 1)];
    };
    return { callModel, calls };
  }

  it("FLAG OFF: exactly one model call, tools never offered, no fetches (== today)", async () => {
    const { callModel, calls } = recorder([turn({ text: "hi" })]);
    const r = await runFetchLoop({
      messages: [{ role: "user", content: "q" }],
      webFetchEnabled: false,
      callModel,
      executeFetch: async () => {
        throw new Error("must not fetch when the flag is off");
      },
      now: () => 0,
    });
    expect(calls).toHaveLength(1);
    expect(calls[0].useTools).toBe(false);
    expect(r.text).toBe("hi");
    expect(r.fetches).toEqual([]);
    expect(r.usage).toEqual(USAGE);
    expect(r.stopReason).toBe("end_turn");
  });

  it("FLAG ON: fetches once, feeds the result back, then answers", async () => {
    const { callModel, calls } = recorder([
      turn({ toolUses: [{ id: "t1", url: "https://grants.gov/x" }], stopReason: "tool_use", rawContent: [{ type: "tool_use", id: "t1" }] }),
      turn({ text: "answer" }),
    ]);
    const executed: unknown[] = [];
    const r = await runFetchLoop({
      messages: [{ role: "user", content: "q" }],
      webFetchEnabled: true,
      callModel,
      executeFetch: async (url) => {
        executed.push(url);
        return { resultText: "FRAMED", audit: { url: String(url), ok: true, fetchedAt: "T" } };
      },
      now: () => 0,
    });
    expect(executed).toEqual(["https://grants.gov/x"]);
    expect(calls.map((c) => c.useTools)).toEqual([true, true]);
    expect(r.text).toBe("answer");
    expect(r.fetches).toHaveLength(1);
    // The second call carries the appended assistant tool_use turn + user tool_result turn.
    expect(calls[1].messagesLen).toBe(calls[0].messagesLen + 2);
    // Usage summed across the two calls.
    expect(r.usage?.input_tokens).toBe(20);
  });

  it("stops offering tools after MAX_TOOL_ROUNDS, forcing a final text call", async () => {
    const { callModel, calls } = recorder([
      turn({ toolUses: [{ id: "t", url: "https://grants.gov/a" }], stopReason: "tool_use" }),
    ]); // always asks for a tool
    const r = await runFetchLoop({
      messages: [{ role: "user", content: "q" }],
      webFetchEnabled: true,
      callModel,
      executeFetch: async () => ({ resultText: "F", audit: { url: "u", ok: true, fetchedAt: "T" } }),
      now: () => 0,
      maxToolRounds: 2,
    });
    // round0 tool, round1 tool, round2 forced (no tools) -> finalize
    expect(calls.map((c) => c.useTools)).toEqual([true, true, false]);
    expect(r.fetches).toHaveLength(2);
  });

  it("stops offering tools once the wall-clock deadline is spent", async () => {
    let t = 0;
    const { callModel, calls } = recorder([turn({ toolUses: [{ id: "t", url: "https://grants.gov/a" }], stopReason: "tool_use" })]);
    const r = await runFetchLoop({
      messages: [{ role: "user", content: "q" }],
      webFetchEnabled: true,
      callModel: async (opts) => {
        const res = await callModel(opts);
        t = 1000; // blow the 500ms deadline after the first call
        return res;
      },
      executeFetch: async () => ({ resultText: "F", audit: { url: "u", ok: true, fetchedAt: "T" } }),
      now: () => t,
      deadlineMs: 500,
      maxToolRounds: 5,
    });
    expect(calls.map((c) => c.useTools)).toEqual([true, false]);
    expect(r.fetches).toHaveLength(1);
  });

  it("passes the full remaining budget on the first call (first timeout == CALL_TIMEOUT_MS upstream)", async () => {
    const { callModel, calls } = recorder([turn({ text: "hi" })]);
    await runFetchLoop({
      messages: [{ role: "user", content: "q" }],
      webFetchEnabled: false,
      callModel,
      executeFetch: async () => ({ resultText: "", audit: { url: "", ok: true, fetchedAt: "T" } }),
      now: () => 0,
      deadlineMs: 220_000,
    });
    expect(calls[0].remainingMs).toBe(220_000);
  });
});
