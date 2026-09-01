import { describe, it, expect } from "vitest";
import {
  narrativeGuard,
  stripSeatCodes,
  structureConfig,
  fitNarrativeEnabled,
  FORBIDDEN_NARRATIVE_MARKERS,
  NARRATIVE_STRUCTURE_ADDENDUM,
} from "./fit-narrative";

// A frozen stand-in for SUBMIT_TOOL's relevant shape.
const BASE_TOOL = {
  name: "submit_intel_review",
  description: "d",
  input_schema: {
    type: "object" as const,
    properties: { verdict: { type: "string" }, summary: { type: "string" } },
    required: ["verdict", "summary"],
  },
} as const;
const BASE_SYSTEM = "STRUCTURE PROMPT";

describe("narrativeGuard", () => {
  it("returns a clean client paragraph unchanged (trimmed)", () => {
    const good =
      "Mississippi County is the kind of applicant this program is built for, but the FY2026 allocation " +
      "table lists it with an asterisk, so it cannot apply as a standalone prime — the path is a formal MOU " +
      "with Blytheville naming a single fiscal agent. This is a conditional 2, not a 3.";
    expect(narrativeGuard(`  ${good}  `)).toBe(good);
  });

  it("nulls empty / whitespace / absent", () => {
    expect(narrativeGuard("")).toBeNull();
    expect(narrativeGuard("   \n ")).toBeNull();
    expect(narrativeGuard(null)).toBeNull();
    expect(narrativeGuard(undefined)).toBeNull();
  });

  it("nulls on scoring/QA machinery leaks (rule b, case-insensitive)", () => {
    expect(narrativeGuard("The engine scored this a 3 but it cannot prime.")).toBeNull();
    expect(narrativeGuard("QA found the county is disparate.")).toBeNull();
    expect(narrativeGuard("This is currently UNVERIFIED against the source.")).toBeNull();
    expect(narrativeGuard("The fit score should be a 2 here.")).toBeNull();
    expect(narrativeGuard("Per IntellEngine, participation requires an MOU.")).toBeNull();
  });

  it("nulls on staff-instruction framing leaks (rule b)", () => {
    expect(narrativeGuard("Tell the client they cannot prime this directly.")).toBeNull();
    expect(narrativeGuard("Position this as a partnership opportunity with Blytheville.")).toBeNull();
    expect(narrativeGuard("Frame it as a fiscal-agent arrangement.")).toBeNull();
    expect(narrativeGuard("Note to staff: the county is on the disparate list.")).toBeNull();
  });

  it("EVERY declared marker actually trips the guard (no dead entries)", () => {
    for (const m of FORBIDDEN_NARRATIVE_MARKERS) {
      expect(narrativeGuard(`A genuine grounded sentence. ${m} and more prose.`)).toBeNull();
    }
  });

  it("does not false-positive on legitimate advice that merely mentions 'score' or 'we'", () => {
    // "we'd pursue", "score" (as a bare noun of the net result) are fine — only the machinery phrases leak.
    const ok =
      "We'd pursue this only through an MOU with Blytheville; the construction and vehicle costs you named " +
      "would need a waiver. On balance this scores as a conditional fit, not a clean one.";
    expect(narrativeGuard(ok)).toBe(ok);
  });

  it("STRIPS seat codes rather than nulling (never falls back to a coded engine paragraph)", () => {
    // The observed leak: the model echoes the matcher's seat labels into a client-facing paragraph.
    const coded =
      "The college genuinely fills a qualitative research unit (S0_2), CCDF policy expertise (S0_3), and " +
      "community engagement (S0_6). It cannot prime.";
    const out = narrativeGuard(coded);
    expect(out).not.toBeNull();
    expect(out).not.toMatch(/S\d+_\d+|\(P\d+\)/); // no code survives
    expect(out).toContain("qualitative research unit"); // the plain-language reasoning is kept
    expect(out).toContain("It cannot prime.");
  });
});

describe("stripSeatCodes", () => {
  it("removes a bare parenthetical code and its leading space", () => {
    expect(stripSeatCodes("a qualitative research unit (S0_2), and more")).toBe(
      "a qualitative research unit, and more",
    );
    expect(stripSeatCodes("the prime seat (P0) is unfilled")).toBe("the prime seat is unfilled");
  });

  it("removes a parenthetical that opens with a code but carries a description", () => {
    expect(stripSeatCodes("community engagement (S0_6, e.g. town halls) is needed")).toBe(
      "community engagement is needed",
    );
  });

  it("removes a truncation-dangling unclosed parenthetical at the end", () => {
    // The exact broken output Shannon saw: a generation cut mid-word inside the code parenthetical.
    expect(stripSeatCodes("stakeholder engagement (S0_6, e.")).toBe("stakeholder engagement");
  });

  it("removes a bare underscore-form token in prose", () => {
    expect(stripSeatCodes("the org fills S0_2 and S0_3 here")).toBe("the org fills and here");
  });

  it("leaves legitimate prose alone (no false positives on bills / phases / clean text)", () => {
    const clean = "It cannot prime; the path is an MOU with Blytheville.";
    expect(stripSeatCodes(clean)).toBe(clean);
    // A bare P/S token in running prose (a bill "S.1234", a phase "P2") is NOT a seat label and is kept.
    expect(stripSeatCodes("Senate bill S.1234 and phase P2 apply.")).toBe("Senate bill S.1234 and phase P2 apply.");
    // Under-the-hood: an underscore form only ever comes from the seat menu, so it is safe to strip; a
    // bare "S3"/"P2" is not, so we require the underscore before stripping unparenthesised.
    expect(stripSeatCodes("Meets 24 CFR 578 and Section 8 rules.")).toBe("Meets 24 CFR 578 and Section 8 rules.");
  });

  it("is idempotent", () => {
    const once = stripSeatCodes("a unit (S0_2), b unit (S0_3), c (S0_6, e.g. x)");
    expect(stripSeatCodes(once)).toBe(once);
    expect(once).not.toMatch(/S\d+_\d+/);
  });
});

describe("structureConfig", () => {
  it("OFF is byte-identical: base tool + base system, no narrative property, no addendum", () => {
    const { tool, system } = structureConfig(false, BASE_TOOL, BASE_SYSTEM);
    expect(tool).toBe(BASE_TOOL); // referential identity — nothing cloned
    expect(system).toBe(BASE_SYSTEM);
    expect("narrative" in tool.input_schema.properties).toBe(false);
  });

  it("ON adds the narrative property (optional, not in required) and appends the addendum", () => {
    const { tool, system } = structureConfig(true, BASE_TOOL, BASE_SYSTEM);
    expect("narrative" in tool.input_schema.properties).toBe(true);
    expect(system).toContain(NARRATIVE_STRUCTURE_ADDENDUM.trim().slice(0, 20));
    // never mutates the base
    expect("narrative" in BASE_TOOL.input_schema.properties).toBe(false);
    // narrative stays OPTIONAL so a model that omits it doesn't break the forced-tool call
    expect((tool.input_schema as { required?: readonly string[] }).required).not.toContain("narrative");
  });
});

describe("fitNarrativeEnabled", () => {
  it("defaults OFF; only the exact string 'true' enables", () => {
    const prev = process.env.FIT_NARRATIVE_ENABLED;
    try {
      delete process.env.FIT_NARRATIVE_ENABLED;
      expect(fitNarrativeEnabled()).toBe(false);
      process.env.FIT_NARRATIVE_ENABLED = "1";
      expect(fitNarrativeEnabled()).toBe(false);
      process.env.FIT_NARRATIVE_ENABLED = "true";
      expect(fitNarrativeEnabled()).toBe(true);
    } finally {
      if (prev === undefined) delete process.env.FIT_NARRATIVE_ENABLED;
      else process.env.FIT_NARRATIVE_ENABLED = prev;
    }
  });
});
