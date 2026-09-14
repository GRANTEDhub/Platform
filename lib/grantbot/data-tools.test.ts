import { describe, it, expect, afterEach } from "vitest";
import {
  grantbotDataToolsEnabled,
  executeDataTool,
  formatProgramAwards,
  formatOrgHistory,
  formatSamEntity,
  PROGRAM_AWARDS_TOOL,
  PROGRAM_AWARDS_TOOL_NAME,
  ORG_HISTORY_TOOL,
  ORG_HISTORY_TOOL_NAME,
  SAM_ENTITY_TOOL,
  SAM_ENTITY_TOOL_NAME,
  DATA_TOOLS_INSTRUCTION_BLOCK,
  type DataToolDeps,
} from "./data-tools";
import type { ProgramAwardee, USASpendingResult } from "@/lib/grants/usaspending";
import type { SamEntity } from "@/lib/sam/client";
import { SamError } from "@/lib/sam/client";

// Deterministic plumbing for GrantBot's federal-data tools: flag gate, tool schemas, and the
// executor's formatting + typed-gap discipline, all with the data clients INJECTED so no network,
// model, or .gov API is touched. The behavioural proof (does the model USE them well) is the
// model-in-the-loop data-tools.eval.test.ts, which gates the flag flip.

// ── Fixtures ─────────────────────────────────────────────────────────────────────────────────────
const awardee = (over: Partial<ProgramAwardee> = {}): ProgramAwardee => ({
  name: "Arkansas Dept of Transportation",
  state: null,
  award_count: 3,
  total_awarded: 12_400_000,
  agencies: ["Department of Transportation"],
  recipient_id: "r1",
  most_recent_year: "2025",
  ...over,
});

const usaHistory = (over: Partial<USASpendingResult> = {}): USASpendingResult => ({
  has_federal_grant_history: true,
  award_count: 2,
  total_awarded: 3_500_000,
  agencies: ["EPA", "DOT"],
  most_recent: {
    award_id: "a1",
    recipient_name: "Mississippi County",
    award_amount: 1_200_000,
    awarding_agency: "EPA",
    start_date: "2024-03-01",
    award_type: "02",
  },
  search_term: "Mississippi County",
  verified: true,
  ...over,
});

const samEntity = (over: Partial<SamEntity> = {}): SamEntity => ({
  uei: "ABC123DEF456",
  legalName: "Mississippi County",
  city: "Blytheville",
  state: "AR",
  status: "Active",
  expirationDate: "2026-11-01",
  ...over,
});

// A deps object whose four functions default to "returns nothing"; each test overrides what it needs.
function deps(over: Partial<DataToolDeps> = {}): DataToolDeps {
  return {
    findProgramAwardees: async () => [],
    checkPastPerformance: async () => usaHistory({ has_federal_grant_history: false, award_count: 0, total_awarded: 0, agencies: [], most_recent: null }),
    lookupByUei: async () => null,
    searchByNameState: async () => [],
    ...over,
  };
}

const at = () => "2026-09-14T00:00:00Z";

// ── Flag gate ────────────────────────────────────────────────────────────────────────────────────
describe("grantbotDataToolsEnabled — off unless exactly 'true'", () => {
  const prev = process.env.GRANTBOT_DATA_TOOLS_ENABLED;
  afterEach(() => {
    if (prev === undefined) delete process.env.GRANTBOT_DATA_TOOLS_ENABLED;
    else process.env.GRANTBOT_DATA_TOOLS_ENABLED = prev;
  });
  it("is false when unset (the instant-revert default)", () => {
    delete process.env.GRANTBOT_DATA_TOOLS_ENABLED;
    expect(grantbotDataToolsEnabled()).toBe(false);
  });
  it("is false for any value other than 'true'", () => {
    process.env.GRANTBOT_DATA_TOOLS_ENABLED = "1";
    expect(grantbotDataToolsEnabled()).toBe(false);
    process.env.GRANTBOT_DATA_TOOLS_ENABLED = "TRUE";
    expect(grantbotDataToolsEnabled()).toBe(false);
  });
  it("is true only for exactly 'true'", () => {
    process.env.GRANTBOT_DATA_TOOLS_ENABLED = "true";
    expect(grantbotDataToolsEnabled()).toBe(true);
  });
});

// ── Tool schemas ─────────────────────────────────────────────────────────────────────────────────
describe("tool schemas are server-side constants with the expected names", () => {
  it("names line up with the dispatch constants", () => {
    expect(PROGRAM_AWARDS_TOOL.name).toBe(PROGRAM_AWARDS_TOOL_NAME);
    expect(ORG_HISTORY_TOOL.name).toBe(ORG_HISTORY_TOOL_NAME);
    expect(SAM_ENTITY_TOOL.name).toBe(SAM_ENTITY_TOOL_NAME);
  });
  it("program-awards requires cfda; org-history requires org_name; sam requires neither (name OR uei)", () => {
    expect(PROGRAM_AWARDS_TOOL.input_schema.required).toContain("cfda");
    expect(ORG_HISTORY_TOOL.input_schema.required).toContain("org_name");
    expect((SAM_ENTITY_TOOL.input_schema as { required?: string[] }).required).toBeUndefined();
  });
  it("the instruction block is cacheable:false (appended after the cache breakpoint)", () => {
    expect(DATA_TOOLS_INSTRUCTION_BLOCK.cacheable).toBe(false);
    expect(DATA_TOOLS_INSTRUCTION_BLOCK.kind).toBe("data-tools");
    // The honesty + eligibility-vs-competitiveness discipline is stated, not implied.
    expect(DATA_TOOLS_INSTRUCTION_BLOCK.text).toContain("A FAILED OR EMPTY LOOKUP IS A FACT, NEVER A GUESS");
    expect(DATA_TOOLS_INSTRUCTION_BLOCK.text).toContain("ENTITY-ELIGIBILITY IS NOT COMPETITIVENESS");
  });
});

// ── lookup_program_awards ────────────────────────────────────────────────────────────────────────
describe("executeDataTool — lookup_program_awards (who wins)", () => {
  it("lists the distinct winners and marks the audit ok", async () => {
    const d = deps({
      findProgramAwardees: async (cfdas) => {
        expect(cfdas).toEqual(["20.284"]);
        return [awardee(), awardee({ name: "State of Missouri DOT", state: "MO", most_recent_year: "2024" })];
      },
    });
    const { resultText, audit } = await executeDataTool(
      { name: PROGRAM_AWARDS_TOOL_NAME, input: { cfda: "20.284" } },
      { deps: d, now: at },
    );
    expect(resultText).toContain("winners of CFDA 20.284");
    expect(resultText).toContain("Arkansas Dept of Transportation");
    expect(resultText).toContain("WHAT TYPE of applicant wins");
    expect(audit).toMatchObject({ tool: PROGRAM_AWARDS_TOOL_NAME, ok: true, count: 2 });
  });

  it("passes a state filter through and reflects it in the header", async () => {
    let seenState: string | undefined;
    const d = deps({
      findProgramAwardees: async (_c, opts) => {
        seenState = opts?.state;
        return [awardee({ state: "AR" })];
      },
    });
    const { resultText } = await executeDataTool(
      { name: PROGRAM_AWARDS_TOOL_NAME, input: { cfda: "20.284", state: "AR" } },
      { deps: d, now: at },
    );
    expect(seenState).toBe("AR");
    expect(resultText).toContain("headquartered in AR");
  });

  it("returns a typed GAP (not a guess) when no awards are found", async () => {
    const { resultText, audit } = await executeDataTool(
      { name: PROGRAM_AWARDS_TOOL_NAME, input: { cfda: "99.999" } },
      { deps: deps(), now: at },
    );
    expect(resultText).toContain("no federal grant or cooperative-agreement awards found");
    expect(resultText).toContain("do NOT infer who wins from memory");
    expect(audit).toMatchObject({ ok: false, reason: "no_data" });
  });

  it("refuses without a CFDA rather than guessing one", async () => {
    const { resultText, audit } = await executeDataTool(
      { name: PROGRAM_AWARDS_TOOL_NAME, input: {} },
      { deps: deps(), now: at },
    );
    expect(resultText).toContain("No CFDA");
    expect(audit).toMatchObject({ ok: false, reason: "bad_input" });
  });

  it("reports a lookup that could not run as a gap, not a fabricated list", async () => {
    const d = deps({ findProgramAwardees: async () => { throw new Error("USASpending 500"); } });
    const { resultText, audit } = await executeDataTool(
      { name: PROGRAM_AWARDS_TOOL_NAME, input: { cfda: "20.284" } },
      { deps: d, now: at },
    );
    expect(resultText).toContain("could not run");
    expect(resultText).toContain("do not infer who wins");
    expect(audit).toMatchObject({ ok: false, reason: "upstream" });
  });
});

// ── lookup_org_federal_history ───────────────────────────────────────────────────────────────────
describe("executeDataTool — lookup_org_federal_history (past performance)", () => {
  it("summarizes a real federal history", async () => {
    const d = deps({ checkPastPerformance: async (name) => usaHistory({ search_term: name }) });
    const { resultText, audit } = await executeDataTool(
      { name: ORG_HISTORY_TOOL_NAME, input: { org_name: "Mississippi County" } },
      { deps: d, now: at },
    );
    expect(resultText).toContain("Mississippi County");
    expect(resultText).toContain("2 federal grants");
    expect(audit).toMatchObject({ ok: true, count: 2 });
  });

  it("distinguishes 'no history' (a gap or a name mismatch) from a failed lookup", async () => {
    const { resultText, audit } = await executeDataTool(
      { name: ORG_HISTORY_TOOL_NAME, input: { org_name: "Nowhere Org" } },
      { deps: deps(), now: at },
    );
    expect(resultText).toContain("NO federal grants");
    expect(resultText).toContain("name mismatch");
    expect(audit).toMatchObject({ ok: true, count: 0 }); // verified lookup, just empty
  });

  it("reports an unverified lookup as unverified, never as 'no history'", async () => {
    const d = deps({ checkPastPerformance: async (name) => usaHistory({ search_term: name, verified: false, has_federal_grant_history: false, award_count: 0, note: "USASpending API error: 503" }) });
    const { resultText, audit } = await executeDataTool(
      { name: ORG_HISTORY_TOOL_NAME, input: { org_name: "Some Org" } },
      { deps: d, now: at },
    );
    expect(resultText).toContain("could not run");
    expect(resultText).toContain("do not guess");
    expect(audit).toMatchObject({ ok: false, reason: "upstream" });
  });

  it("refuses without an org name", async () => {
    const { audit } = await executeDataTool(
      { name: ORG_HISTORY_TOOL_NAME, input: {} },
      { deps: deps(), now: at },
    );
    expect(audit).toMatchObject({ ok: false, reason: "bad_input" });
  });
});

// ── lookup_sam_entity ────────────────────────────────────────────────────────────────────────────
describe("executeDataTool — lookup_sam_entity (registration gate)", () => {
  it("looks up by a valid UEI and reports status + expiration", async () => {
    let ueiSeen = "";
    const d = deps({ lookupByUei: async (u) => { ueiSeen = u; return samEntity(); } });
    const { resultText, audit } = await executeDataTool(
      { name: SAM_ENTITY_TOOL_NAME, input: { uei: "ABC123DEF456" } },
      { deps: d, now: at },
    );
    expect(ueiSeen).toBe("ABC123DEF456");
    expect(resultText).toContain("registration Active");
    expect(resultText).toContain("expires 2026-11-01");
    expect(resultText).toContain("PRECONDITION");
    expect(audit).toMatchObject({ ok: true, count: 1 });
  });

  it("searches by name+state when no UEI is given", async () => {
    let args: unknown[] = [];
    const d = deps({ searchByNameState: async (n, s, c) => { args = [n, s, c]; return [samEntity()]; } });
    const { audit } = await executeDataTool(
      { name: SAM_ENTITY_TOOL_NAME, input: { org_name: "Mississippi County", state: "AR" } },
      { deps: d, now: at },
    );
    expect(args).toEqual(["Mississippi County", "AR", null]);
    expect(audit).toMatchObject({ ok: true, count: 1 });
  });

  it("treats 'not found' as a possible eligibility gap OR name mismatch, never as registered", async () => {
    const { resultText, audit } = await executeDataTool(
      { name: SAM_ENTITY_TOOL_NAME, input: { org_name: "Ghost Org" } },
      { deps: deps(), now: at },
    );
    expect(resultText).toContain("no entity found");
    expect(resultText).toContain("do not assume registration");
    expect(audit).toMatchObject({ ok: false, reason: "no_data" });
  });

  it("rejects a UEI-shaped-but-invalid value instead of spending a name search", async () => {
    const { resultText, audit } = await executeDataTool(
      { name: SAM_ENTITY_TOOL_NAME, input: { uei: "IIII0000OOOO" } }, // contains I and O
      { deps: deps(), now: at },
    );
    expect(resultText).toContain("not a valid UEI");
    expect(audit).toMatchObject({ ok: false, reason: "bad_input" });
  });

  it("reports a not-configured SAM environment as unverified, not unregistered", async () => {
    const d = deps({ searchByNameState: async () => { throw new SamError("SAM_API_KEY is not configured.", "config"); } });
    const { resultText, audit } = await executeDataTool(
      { name: SAM_ENTITY_TOOL_NAME, input: { org_name: "Some Org" } },
      { deps: d, now: at },
    );
    expect(resultText).toContain("not configured");
    expect(resultText).toContain("do not assume it");
    expect(audit).toMatchObject({ ok: false, reason: "config" });
  });

  it("refuses without a name or UEI", async () => {
    const { audit } = await executeDataTool(
      { name: SAM_ENTITY_TOOL_NAME, input: {} },
      { deps: deps(), now: at },
    );
    expect(audit).toMatchObject({ ok: false, reason: "bad_input" });
  });
});

// ── Unknown tool ─────────────────────────────────────────────────────────────────────────────────
describe("executeDataTool — unknown tool", () => {
  it("does nothing and says so", async () => {
    const { resultText, audit } = await executeDataTool({ name: "not_a_tool", input: {} }, { deps: deps(), now: at });
    expect(resultText).toContain("Unknown data tool");
    expect(audit).toMatchObject({ ok: false });
  });
});

// ── Formatters, directly ─────────────────────────────────────────────────────────────────────────
describe("formatters render floors + estimates language", () => {
  it("program awards caps the shown list and notes the remainder", () => {
    const many = Array.from({ length: 20 }, (_, i) => awardee({ name: `Org ${i}`, recipient_id: `r${i}` }));
    const out = formatProgramAwards(["20.284"], undefined, many);
    expect(out).toContain("20 distinct recipient organizations");
    expect(out).toContain("more distinct recipients not shown");
    expect(out).toContain("estimates");
  });
  it("org history renders a floor caveat", () => {
    expect(formatOrgHistory(usaHistory())).toContain("floor");
  });
  it("sam formatter flags an expired registration as a renewal gate", () => {
    const out = formatSamEntity("X", [samEntity({ status: "Expired", expirationDate: "2024-01-01" })]);
    expect(out).toContain("registration Expired");
    expect(out).toContain("renew");
  });
});
