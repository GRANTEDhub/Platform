import { describe, it, expect } from "vitest";
import {
  narrativeGuard,
  stripSeatCodes,
  scrubCardSeatCodes,
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
    expect(out).not.toMatch(/S\d+_\d+/); // no supporting-seat code survives
    expect(out).toContain("qualitative research unit"); // the plain-language reasoning is kept
    expect(out).toContain("It cannot prime.");
  });
});

describe("stripSeatCodes", () => {
  it("removes a bare parenthetical supporting-seat code and its leading space", () => {
    expect(stripSeatCodes("a qualitative research unit (S0_2), and more")).toBe(
      "a qualitative research unit, and more",
    );
  });

  it("STRIPS prime codes too — the whole [SP] family, unconditionally (Shannon, 2026-09-02)", () => {
    // Reverses the earlier P-preservation (Codex #480): a prime "P<n>" is machinery and must never render,
    // so it is stripped in every shape — bare and parenthetical — accepting the collision with a legit
    // "P30"/"P2" as the cost of "no code of any form, ever".
    expect(stripSeatCodes("the prime seat (P0) is unfilled")).toBe("the prime seat is unfilled");
    expect(stripSeatCodes("the org takes P0 as prime")).toBe("the org takes as prime");
    expect(stripSeatCodes("fills P1 and S0_2 here")).toBe("fills and here");
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

  it("leaves genuinely-safe prose alone (requires a DIGIT right after S/P; case-sensitive)", () => {
    const clean = "It cannot prime; the path is an MOU with Blytheville.";
    expect(stripSeatCodes(clean)).toBe(clean);
    // A DIGIT must immediately follow an UPPERCASE S/P for a match, so a bill "S.1234" (S then "."), a
    // heading "Section 8" (S then "e"), a regulation "24 CFR 578", and any lowercase word are all safe.
    expect(stripSeatCodes("Senate bill S.1234 and Section 8 of 24 CFR 578 apply.")).toBe(
      "Senate bill S.1234 and Section 8 of 24 CFR 578 apply.",
    );
    // The accepted collision (documented): an UPPERCASE "P<digit>" in real prose IS now stripped — the cost
    // of catching every prime code. Lowercase "phase-2" is untouched (case-sensitive [SP]).
    expect(stripSeatCodes("the phase-2 trial and P2 milestone")).toBe("the phase-2 trial and milestone");
  });

  it("is idempotent", () => {
    const once = stripSeatCodes("a unit (S0_2), b unit (S0_3), c (S0_6, e.g. x)");
    expect(stripSeatCodes(once)).toBe(once);
    expect(once).not.toMatch(/S\d+_\d+/);
  });

  // The widened family (Shannon, 2026-09-02): the strip must catch EVERY S<digit>_ variant unconditionally,
  // not only the S<digit>_<digit> form the first version required — a trailing-underscore truncation "S0_" /
  // "S1_" and a nested "S0_1_2" slipped through and reached the IntellEngine Intel paragraph.
  it("removes the full underscore forms Shannon saw live (S0_1, S1_2)", () => {
    expect(stripSeatCodes("the org fills S0_1 and S1_2 today")).toBe("the org fills and today");
  });

  it("removes a trailing-underscore truncation with NO digit after it (S0_, S1_), bare and parenthetical", () => {
    expect(stripSeatCodes("the org fills S0_ and S1_ here")).toBe("the org fills and here");
    expect(stripSeatCodes("community engagement (S0_) matters")).toBe("community engagement matters");
  });

  it("removes a nested underscore form (S0_1_2)", () => {
    expect(stripSeatCodes("the org fills S0_1_2 today")).toBe("the org fills today");
    expect(stripSeatCodes("engagement (S0_1_2) here")).toBe("engagement here");
  });

  it("leaves NO seat/prime code of any shape in the output", () => {
    const coded = "P0 fills S0_1, S1_2, S0_, S1_, and S0_1_2 (S0_6, e.g. x) with P1 plus a dangling (S0_6, e.";
    const out = stripSeatCodes(coded);
    expect(out).not.toMatch(/[SP]\d+(?:_\d*)*/); // the whole [SP] family, every shape
  });
});

// The card-load scrub — the single choke point that cleans EVERY free-text field a detail page renders
// (why_this_org bullets, concept_synopsis, before_you_approve, and the reasoning_context prose that feeds
// the rationale lead/mitigation), so no surface can leak a seat code regardless of which field carried it.
describe("scrubCardSeatCodes", () => {
  it("scrubs codes from every free-text field and leaves the rest untouched", () => {
    const card = {
      id: "c1",
      fit_score: 2,
      why_this_org: ["fills S0_1 the research seat", "no code here"],
      concept_synopsis: "The college fills S0_2 and S1_ under a partner.",
      before_you_approve: ["STOP: confirm S0_3 capacity"],
      reasoning_context: {
        consortium_rationale: "Needs a prime; the org fills S0_6 (S0_6, e.g. town halls).",
        fit_score_derivation: "Capped at conditional on seat_role.",
        role_assignment_logic: null,
      },
    };
    const out = scrubCardSeatCodes(card);
    // No S<digit>_ token survives anywhere it renders.
    expect(JSON.stringify(out)).not.toMatch(/S\d+_/);
    // The reasoning is kept, just de-coded.
    expect(out.why_this_org?.[0]).toBe("fills the research seat");
    expect(out.why_this_org?.[1]).toBe("no code here");
    expect(out.concept_synopsis).toBe("The college fills and under a partner.");
    expect(out.before_you_approve?.[0]).toBe("STOP: confirm capacity");
    expect((out.reasoning_context as { consortium_rationale: string }).consortium_rationale).toBe(
      "Needs a prime; the org fills.",
    );
    // Untouched fields pass through, and a null sub-field stays null.
    expect(out.id).toBe("c1");
    expect(out.fit_score).toBe(2);
    expect((out.reasoning_context as { role_assignment_logic: null }).role_assignment_logic).toBeNull();
  });

  it("does not mutate the input and tolerates absent/null fields", () => {
    const card = { id: "c2", why_this_org: ["fills S0_1 here"], reasoning_context: null };
    const out = scrubCardSeatCodes(card);
    expect(card.why_this_org[0]).toBe("fills S0_1 here"); // input untouched
    expect(out.why_this_org?.[0]).toBe("fills here");
    expect(out.reasoning_context).toBeNull();
    // A card whose scrubbable fields are all null/absent is returned intact — nothing to scrub, no throw.
    const bare = { id: "c3", why_this_org: null, concept_synopsis: null, before_you_approve: null, reasoning_context: null };
    expect(scrubCardSeatCodes(bare)).toEqual(bare);
  });

  it("scrubs the per-factor rationales in factor_scores AND qa_factor_scores (Codex #485)", () => {
    // The raw FactorBreakdown on /review/[id] renders factor rationales straight into a title + hover, so
    // the card-load scrub must reach both factor collections, not just the prose fields.
    const factor = (rationale: string) => ({ rating: "weak" as const, rationale });
    const card = {
      id: "c4",
      factor_scores: {
        seat_role: factor("Fills the supporting seat S0_2 but not the prime P0."),
        eligibility: factor("Entity-eligible."),
        geographic: factor("In-region."),
        program_history: factor("Some history."),
        cost_share: factor("No match required."),
        mission: factor("Aligned."),
      },
      qa_factor_scores: {
        seat_role: factor("QA: still only S0_2, cannot prime P0."),
        eligibility: factor("QA confirms eligibility."),
        geographic: factor("QA in-region."),
        program_history: factor("QA history."),
        cost_share: factor("QA cost-share."),
        mission: factor("QA mission."),
      },
    };
    const out = scrubCardSeatCodes(card);
    expect(JSON.stringify(out)).not.toMatch(/[SP]\d+(?:_\d*)*/); // no code in either factor collection
    expect(out.factor_scores?.seat_role.rationale).toBe("Fills the supporting seat but not the prime.");
    expect(out.qa_factor_scores?.seat_role.rationale).toBe("QA: still only, cannot prime.");
    // Ratings and other factors are untouched.
    expect(out.factor_scores?.seat_role.rating).toBe("weak");
    expect(out.factor_scores?.eligibility.rationale).toBe("Entity-eligible.");
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
