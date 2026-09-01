import { describe, it, expect } from "vitest";
import { buildRecommendation } from "./recommendation";

describe("buildRecommendation", () => {
  it("3 → clean SEND; staff verb 'Send', client verb 'Pursue'", () => {
    expect(buildRecommendation(3, "Prime", "staff")).toEqual({ call: "SEND", verb: "Send", capacity: "Prime", conditional: false });
    // The client sees the SEND, but as THEIR action word ("Pursue") — never "Send", which is our internal act.
    expect(buildRecommendation(3, "Prime", "client")).toEqual({ call: "SEND", verb: "Pursue", capacity: "Prime", conditional: false });
  });

  it("2 → conditional SEND (visibly distinct from a clean 3)", () => {
    const rec = buildRecommendation(2, "Sub / co-applicant", "staff");
    expect(rec).toEqual({ call: "SEND", verb: "Send", capacity: "Sub / co-applicant", conditional: true });
    // The conditional flag is the only thing that separates a 2's SEND from a 3's — assert it's set.
    expect(rec?.conditional).toBe(true);
  });

  it("1 → PASS on the staff side", () => {
    expect(buildRecommendation(1, "Prime", "staff")).toEqual({ call: "PASS", verb: "Pass", capacity: "Prime", conditional: false });
  });

  it("1 → NO recommendation on the client side (never-hide edge: a passed grant must not read 'Pass')", () => {
    expect(buildRecommendation(1, "Prime", "client")).toBeNull();
  });

  it("a SEND still renders to the client (client-safe advice, 'Pursue')", () => {
    expect(buildRecommendation(2, "Prime", "client")).toEqual({ call: "SEND", verb: "Pursue", capacity: "Prime", conditional: true });
    expect(buildRecommendation(3, null, "client")).toEqual({ call: "SEND", verb: "Pursue", capacity: null, conditional: false });
  });

  it("null / blank role → no capacity (never fabricates one)", () => {
    expect(buildRecommendation(3, null, "staff")).toEqual({ call: "SEND", verb: "Send", capacity: null, conditional: false });
    expect(buildRecommendation(3, "   ", "staff")).toEqual({ call: "SEND", verb: "Send", capacity: null, conditional: false });
  });

  it("no score → no recommendation", () => {
    expect(buildRecommendation(null, "Prime", "staff")).toBeNull();
  });
});
