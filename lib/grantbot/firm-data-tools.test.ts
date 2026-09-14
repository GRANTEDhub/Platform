import { describe, it, expect, afterEach } from "vitest";
import {
  firmDataToolsEnabled,
  FIRM_DATA_TOOLS_INSTRUCTION_BLOCK,
  PROGRAM_AWARDS_TOOL,
  PROGRAM_AWARDS_TOOL_NAME,
  ORG_HISTORY_TOOL,
  SAM_ENTITY_TOOL,
  executeDataTool,
} from "./firm-data-tools";

// The firm data-tools wiring reuses the per-client executor + tools verbatim (proven in
// data-tools.test.ts / data-tools.eval); this file covers only the firm-specific surface: its own flag,
// its own instruction block, and that the re-exports resolve.

describe("firmDataToolsEnabled — off unless exactly 'true', independent of the per-client flag", () => {
  const prev = process.env.GRANTBOT_FIRM_DATA_TOOLS_ENABLED;
  const prevClient = process.env.GRANTBOT_DATA_TOOLS_ENABLED;
  afterEach(() => {
    if (prev === undefined) delete process.env.GRANTBOT_FIRM_DATA_TOOLS_ENABLED;
    else process.env.GRANTBOT_FIRM_DATA_TOOLS_ENABLED = prev;
    if (prevClient === undefined) delete process.env.GRANTBOT_DATA_TOOLS_ENABLED;
    else process.env.GRANTBOT_DATA_TOOLS_ENABLED = prevClient;
  });
  it("is false when unset (byte-identical-off default)", () => {
    delete process.env.GRANTBOT_FIRM_DATA_TOOLS_ENABLED;
    expect(firmDataToolsEnabled()).toBe(false);
  });
  it("is false for any value other than 'true', and ignores the per-client flag", () => {
    for (const v of ["1", "TRUE", "yes", "false", ""]) {
      process.env.GRANTBOT_FIRM_DATA_TOOLS_ENABLED = v;
      expect(firmDataToolsEnabled()).toBe(false);
    }
    // The per-client flag being on does NOT enable the firm tools — the two are independent.
    delete process.env.GRANTBOT_FIRM_DATA_TOOLS_ENABLED;
    process.env.GRANTBOT_DATA_TOOLS_ENABLED = "true";
    expect(firmDataToolsEnabled()).toBe(false);
  });
  it("is true only for exactly 'true'", () => {
    process.env.GRANTBOT_FIRM_DATA_TOOLS_ENABLED = "true";
    expect(firmDataToolsEnabled()).toBe(true);
  });
});

describe("FIRM_DATA_TOOLS_INSTRUCTION_BLOCK — firm framing, cacheable:false", () => {
  it("is appended after the cache breakpoint (never enters the shared cached prefix)", () => {
    expect(FIRM_DATA_TOOLS_INSTRUCTION_BLOCK.cacheable).toBe(false);
    expect(FIRM_DATA_TOOLS_INSTRUCTION_BLOCK.kind).toBe("data-tools");
    expect(FIRM_DATA_TOOLS_INSTRUCTION_BLOCK.source).toBe("lib/grantbot/firm-data-tools.ts");
  });
  it("keeps the who-wins-mandatory + no-fabrication + eligibility-vs-competitiveness discipline", () => {
    const t = FIRM_DATA_TOOLS_INSTRUCTION_BLOCK.text;
    expect(t).toContain(PROGRAM_AWARDS_TOOL_NAME);
    expect(t).toMatch(/CALL THE TOOL, DON'T RECALL/);
    expect(t).toContain("fabrication");
    expect(t).toContain("ENTITY-ELIGIBILITY IS NOT COMPETITIVENESS");
    expect(t).toMatch(/FAILED OR EMPTY LOOKUP IS A FACT/);
  });
  it("does NOT reference methodology.ts (the firm bot has no methodology block to supersede)", () => {
    expect(FIRM_DATA_TOOLS_INSTRUCTION_BLOCK.text).not.toContain("methodology");
    expect(FIRM_DATA_TOOLS_INSTRUCTION_BLOCK.text).not.toContain("SUPERSED");
  });
});

describe("re-exports resolve (the per-client tools + executor, reused verbatim)", () => {
  it("carries the three tool definitions and the executor", () => {
    expect(PROGRAM_AWARDS_TOOL.name).toBe(PROGRAM_AWARDS_TOOL_NAME);
    expect(ORG_HISTORY_TOOL.name).toBe("lookup_org_federal_history");
    expect(SAM_ENTITY_TOOL.name).toBe("lookup_sam_entity");
    expect(typeof executeDataTool).toBe("function");
  });
  it("the executor returns a typed gap for an unknown tool (no throw)", async () => {
    const { resultText, audit } = await executeDataTool({ name: "nope", input: {} }, { now: () => "T" });
    expect(resultText).toMatch(/Unknown data tool/);
    expect(audit.ok).toBe(false);
  });
});
