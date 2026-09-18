import { describe, it, expect } from "vitest";
import { CLIENT_PROFILE_TOOL, CLIENT_PROFILE_SYSTEM_PROMPT } from "./profile";

// Deterministic lock on the three-state can_prime contract (B2). The distiller's actual CLASSIFICATION
// quality (does it emit CANNOT for a funder, UNKNOWN for a thin implementer) is the model-in-the-loop gate
// (align-score.eval.test.ts REDISTILL branch). These assertions just prove the CONTRACT that makes it
// possible: the schema permits null, and the prompt makes UNKNOWN the default and false a reserved finding --
// so a future edit cannot silently revert to the old "default can_prime = false" that locked prime-capable
// clients out of the Prime role roster-wide.
describe("client-profile distiller -- three-state can_prime contract (B2)", () => {
  it("the tool schema allows can_prime to be null (UNKNOWN), not just boolean", () => {
    const tool = CLIENT_PROFILE_TOOL as unknown as {
      input_schema: {
        properties: { prime_capacity: { properties: { can_prime: { type: unknown } }; required: string[] } };
      };
    };
    const canPrime = tool.input_schema.properties.prime_capacity.properties.can_prime;
    expect(canPrime.type).toEqual(["boolean", "null"]);
    // Still required: the key must be PRESENT (the model must consciously choose), it may just be null.
    expect(tool.input_schema.properties.prime_capacity.required).toContain("can_prime");
  });

  it("the prompt makes UNKNOWN the default and reserves false for a positive money-mover finding", () => {
    const p = CLIENT_PROFILE_SYSTEM_PROMPT;
    expect(p).toContain("UNKNOWN");
    // null is the default on a thin/ordinary intake; false is a reserved positive finding, never a default.
    expect(p).toContain("money-mover identity"); // the null bullet frames CANNOT as a money-mover finding
    expect(p).toContain("RESERVE for a POSITIVE funder finding");
    expect(p).toContain("the DEFAULT when the intake shows NEITHER"); // null is the default, not false
    expect(p).toContain("WHEN IN DOUBT, USE null");
  });
});
