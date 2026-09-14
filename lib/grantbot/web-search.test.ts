import { describe, it, expect, afterEach } from "vitest";
import {
  grantbotWebSearchEnabled,
  grantbotWebSearchTool,
  extractWebSearchAudit,
  GRANTBOT_MAX_SEARCHES,
  MAX_AUDIT_URLS,
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

describe("extractWebSearchAudit — the server-side audit sink for the one dispatch-less tool", () => {
  const AT = "2026-09-14T12:00:00.000Z";

  it("pairs a server_tool_use search with its result block into one record (query + URLs)", () => {
    const content = [
      { type: "text", text: "some reasoning" },
      { type: "server_tool_use", id: "srv_1", name: "web_search", input: { query: "MS County priority watersheds" } },
      {
        type: "web_search_tool_result",
        tool_use_id: "srv_1",
        content: [
          { type: "web_search_result", url: "https://adeq.state.ar.us/watersheds", title: "ADEQ" },
          { type: "web_search_result", url: "https://example.gov/nrd", title: "NRD" },
        ],
      },
    ];
    const audit = extractWebSearchAudit(content, AT);
    expect(audit).toEqual([
      {
        query: "MS County priority watersheds",
        ok: true,
        count: 2,
        urls: ["https://adeq.state.ar.us/watersheds", "https://example.gov/nrd"],
        at: AT,
      },
    ]);
  });

  it("records an upstream error result as ok:false with the error_code", () => {
    const content = [
      { type: "server_tool_use", id: "srv_e", name: "web_search", input: { query: "x" } },
      { type: "web_search_tool_result", tool_use_id: "srv_e", content: { type: "web_search_tool_result_error", error_code: "max_uses_exceeded" } },
    ];
    const audit = extractWebSearchAudit(content, AT);
    expect(audit).toEqual([{ query: "x", ok: false, reason: "max_uses_exceeded", at: AT }]);
  });

  it("returns [] for a text-only / client-tool-only response (the byte-identical-off guarantee)", () => {
    expect(extractWebSearchAudit([{ type: "text", text: "hi" }], AT)).toEqual([]);
    // A CLIENT tool_use (fetch/data-tools) is NOT a server_tool_use and must not be counted as a search.
    expect(
      extractWebSearchAudit([{ type: "tool_use", id: "t1", name: "fetch_grant_source", input: { url: "x" } }], AT),
    ).toEqual([]);
    expect(extractWebSearchAudit("not an array", AT)).toEqual([]);
    expect(extractWebSearchAudit(null, AT)).toEqual([]);
  });

  it("caps stored URLs at MAX_AUDIT_URLS while count reflects the true total", () => {
    const many = Array.from({ length: MAX_AUDIT_URLS + 5 }, (_, i) => ({
      type: "web_search_result",
      url: `https://example.gov/${i}`,
    }));
    const content = [
      { type: "server_tool_use", id: "srv_big", name: "web_search", input: { query: "q" } },
      { type: "web_search_tool_result", tool_use_id: "srv_big", content: many },
    ];
    const [rec] = extractWebSearchAudit(content, AT);
    expect(rec.count).toBe(MAX_AUDIT_URLS + 5);
    expect(rec.urls).toHaveLength(MAX_AUDIT_URLS);
  });

  it("keeps one record per search across multiple searches in one response", () => {
    const content = [
      { type: "server_tool_use", id: "a", name: "web_search", input: { query: "national" } },
      { type: "web_search_tool_result", tool_use_id: "a", content: [{ type: "web_search_result", url: "https://example.gov/1" }] },
      { type: "server_tool_use", id: "b", name: "web_search", input: { query: "in-state" } },
      { type: "web_search_tool_result", tool_use_id: "b", content: [{ type: "web_search_result", url: "https://example.gov/2" }] },
    ];
    const audit = extractWebSearchAudit(content, AT);
    expect(audit.map((r) => r.query)).toEqual(["national", "in-state"]);
    expect(audit.every((r) => r.ok)).toBe(true);
  });
});
