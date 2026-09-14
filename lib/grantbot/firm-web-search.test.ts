import { describe, it, expect, afterEach } from "vitest";
import {
  firmWebSearchEnabled,
  grantbotWebSearchTool,
  extractWebSearchAudit,
  FIRM_WEB_SEARCH_INSTRUCTION_BLOCK,
  WEB_SEARCH_TOOL_NAME,
} from "./firm-web-search";

// The firm web-search wiring reuses the per-client server tool + audit extractor verbatim (the tool
// TYPE is already eval-proven in intel-review.eval); this file covers only the firm-specific surface:
// its own flag, its own instruction block, and that the re-exports resolve.

describe("firmWebSearchEnabled — off unless exactly 'true', independent of the per-client flag", () => {
  const prev = process.env.GRANTBOT_FIRM_WEB_SEARCH_ENABLED;
  const prevClient = process.env.GRANTBOT_WEB_SEARCH_ENABLED;
  afterEach(() => {
    if (prev === undefined) delete process.env.GRANTBOT_FIRM_WEB_SEARCH_ENABLED;
    else process.env.GRANTBOT_FIRM_WEB_SEARCH_ENABLED = prev;
    if (prevClient === undefined) delete process.env.GRANTBOT_WEB_SEARCH_ENABLED;
    else process.env.GRANTBOT_WEB_SEARCH_ENABLED = prevClient;
  });
  it("is false when unset (byte-identical-off default)", () => {
    delete process.env.GRANTBOT_FIRM_WEB_SEARCH_ENABLED;
    expect(firmWebSearchEnabled()).toBe(false);
  });
  it("is false for any value other than 'true', and ignores the per-client flag", () => {
    process.env.GRANTBOT_FIRM_WEB_SEARCH_ENABLED = "TRUE";
    expect(firmWebSearchEnabled()).toBe(false);
    delete process.env.GRANTBOT_FIRM_WEB_SEARCH_ENABLED;
    process.env.GRANTBOT_WEB_SEARCH_ENABLED = "true";
    expect(firmWebSearchEnabled()).toBe(false);
  });
  it("is true only for exactly 'true'", () => {
    process.env.GRANTBOT_FIRM_WEB_SEARCH_ENABLED = "true";
    expect(firmWebSearchEnabled()).toBe(true);
  });
});

describe("grantbotWebSearchTool — the reused server tool", () => {
  it("is the web_search server tool with a per-request budget", () => {
    const tool = grantbotWebSearchTool() as { type: string; name: string; max_uses: number };
    expect(tool.name).toBe(WEB_SEARCH_TOOL_NAME);
    expect(tool.name).toBe("web_search");
    expect(tool.type).toBe("web_search_20250305");
    expect(tool.max_uses).toBeGreaterThan(0);
  });
});

describe("FIRM_WEB_SEARCH_INSTRUCTION_BLOCK — firm framing, cacheable:false", () => {
  it("is appended after the cache breakpoint", () => {
    expect(FIRM_WEB_SEARCH_INSTRUCTION_BLOCK.cacheable).toBe(false);
    expect(FIRM_WEB_SEARCH_INSTRUCTION_BLOCK.kind).toBe("web-search");
    expect(FIRM_WEB_SEARCH_INSTRUCTION_BLOCK.source).toBe("lib/grantbot/firm-web-search.ts");
  });
  it("frames a result as untrusted evidence, forbids fabricating, and pins soft-vs-hard", () => {
    const t = FIRM_WEB_SEARCH_INSTRUCTION_BLOCK.text;
    expect(t).toContain("UNTRUSTED THIRD-PARTY EVIDENCE");
    expect(t).toContain("NEVER FABRICATE FROM A GAP");
    expect(t).toMatch(/soft criterion .*hard gate/);
    expect(t).toMatch(/Keep the searching OUT of your reply/);
  });
});

describe("extractWebSearchAudit re-export resolves", () => {
  it("returns [] for a text-only response (server tool did not fire)", () => {
    expect(extractWebSearchAudit([{ type: "text", text: "hi" }], "T")).toEqual([]);
  });
});
