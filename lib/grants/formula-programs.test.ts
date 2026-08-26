import { describe, it, expect } from "vitest";
import { formulaProgramTag, FORMULA_PROGRAMS } from "./formula-programs";

// Deterministic — pure classifier, no model, no network. Locks: the tag fires on a known formula CFDA,
// normalizes a letter suffix, is empty for unknown / missing listings, and never claims formula for a
// program we have not confirmed.

describe("formulaProgramTag", () => {
  it("tags a known formula program (JAG 16.738)", () => {
    const t = formulaProgramTag([{ number: "16.738" }]);
    expect(t.isFormula).toBe(true);
    expect(t.cfda).toBe("16.738");
    expect(t.program?.allocationNote).toMatch(/asterisk|allocation|State Administering/i);
  });

  it("tags VOCA (16.575) as formula — a subgrantee-through-the-state program (the unseeded discovery case)", () => {
    const t = formulaProgramTag([{ number: "16.575" }]);
    expect(t.isFormula).toBe(true);
    expect(t.program?.allocationNote).toMatch(/subgrantee|state VOCA/i);
  });

  it("normalizes a trailing letter suffix (16.738A → 16.738)", () => {
    expect(formulaProgramTag([{ number: "16.738A" }]).isFormula).toBe(true);
  });

  it("returns the FIRST matching listing when several are present", () => {
    const t = formulaProgramTag([{ number: "00.000" }, { number: "16.588" }]);
    expect(t.isFormula).toBe(true);
    expect(t.cfda).toBe("16.588");
  });

  it("is not formula for an unknown / competitive CFDA", () => {
    expect(formulaProgramTag([{ number: "93.999" }]).isFormula).toBe(false);
  });

  it("is not formula for missing / empty / null listings", () => {
    expect(formulaProgramTag(null).isFormula).toBe(false);
    expect(formulaProgramTag(undefined).isFormula).toBe(false);
    expect(formulaProgramTag([]).isFormula).toBe(false);
    expect(formulaProgramTag([{ number: "" }, { number: null }]).isFormula).toBe(false);
  });

  it("every seeded entry carries a non-empty label and allocation note", () => {
    for (const [cfda, p] of Object.entries(FORMULA_PROGRAMS)) {
      expect(p.label.trim().length, `${cfda} label`).toBeGreaterThan(0);
      expect(p.allocationNote.trim().length, `${cfda} note`).toBeGreaterThan(0);
    }
  });
});
