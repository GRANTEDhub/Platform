import { describe, it, expect, afterEach } from "vitest";
import {
  grantbotWebSearchEnabled,
  grantbotWebSearchTool,
  GRANTBOT_MAX_SEARCHES,
  WEB_SEARCH_INSTRUCTION_BLOCK,
  WEB_SEARCH_TOOL_NAME,
} from "./web-search";

// Deterministic plumbing for GrantBot's open-web search tool: the flag gate, the server-tool shape,
// and the instruction block's discipline. The tool TYPE itself is already proven green in the intel
// eval (it reuses lib/grants/intel-web-search's webSearchTool), so there is no separate eval here.

describe("grantbotWebSearchEnabled — off unless exactly 'true'", () => {
  const prev = process.env.GRANTBOT_WEB_SEARCH_ENABLED;
  afterEach(() => {
    if (prev === undefined) delete process.env.GRANTBOT_WEB_SEARCH_ENABLED;
    else process.env.GRANTBOT_WEB_SEARCH_ENABLED = prev;
  });
  it("is false when unset (the byte-identical-off default)", () => {
    delete process.env.GRANTBOT_WEB_SEARCH_ENABLED;
    expect(grantbotWebSearchEnabled()).toBe(false);
  });
  it("is false for any value other than 'true'", () => {
    process.env.GRANTBOT_WEB_SEARCH_ENABLED = "1";
    expect(grantbotWebSearchEnabled()).toBe(false);
    process.env.GRANTBOT_WEB_SEARCH_ENABLED = "TRUE";
    expect(grantbotWebSearchEnabled()).toBe(false);
  });
  it("is true only for exactly 'true'", () => {
    process.env.GRANTBOT_WEB_SEARCH_ENABLED = "true";
    expect(grantbotWebSearchEnabled()).toBe(true);
  });
});

describe("grantbotWebSearchTool — the reused server-tool definition", () => {
  it("is the web_search server tool with the per-request budget", () => {
    const tool = grantbotWebSearchTool() as { type: string; name: string; max_uses: number };
    expect(tool.name).toBe(WEB_SEARCH_TOOL_NAME);
    expect(tool.name).toBe("web_search");
    expect(tool.type).toBe("web_search_20250305"); // the proven type, single-sourced from intel-web-search
    expect(tool.max_uses).toBe(GRANTBOT_MAX_SEARCHES);
  });
});

describe("WEB_SEARCH_INSTRUCTION_BLOCK — cacheable:false + the search discipline", () => {
  it("is appended after the cache breakpoint (never enters the shared cached prefix)", () => {
    expect(WEB_SEARCH_INSTRUCTION_BLOCK.cacheable).toBe(false);
    expect(WEB_SEARCH_INSTRUCTION_BLOCK.kind).toBe("web-search");
  });
  it("frames a result as untrusted evidence and forbids fabricating from a gap", () => {
    expect(WEB_SEARCH_INSTRUCTION_BLOCK.text).toContain("UNTRUSTED THIRD-PARTY EVIDENCE");
    expect(WEB_SEARCH_INSTRUCTION_BLOCK.text).toContain("NEVER FABRICATE FROM A GAP");
    // The soft-vs-hard distinction that this very question exposed (preference != gate).
    expect(WEB_SEARCH_INSTRUCTION_BLOCK.text).toMatch(/soft criterion .*hard gate/);
    // Plumbing-hygiene: no play-by-play of the searching.
    expect(WEB_SEARCH_INSTRUCTION_BLOCK.text).toMatch(/Keep the searching OUT of your reply/);
  });
});
