import { describe, it, expect } from "vitest";
import { buildRecommendation, buildVerdict } from "./recommendation";

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

  it("a hard kill forces PASS regardless of a high fit score (closed deadline over a fit-3)", () => {
    // The `closed` kill is NOT score-pinned, so the score can still be 3 — the recommendation must
    // still be PASS, matching the no-go verdict lead. Staff-only.
    expect(buildRecommendation(3, "Prime", "staff", { kind: "closed" })).toEqual({
      call: "PASS",
      verb: "Pass",
      capacity: "Prime",
      conditional: false,
    });
    expect(buildRecommendation(3, "Prime", "client", { kind: "closed" })).toBeNull();
  });

  it("an ineligible hard kill also lands on PASS (and never a client 'Pursue')", () => {
    expect(buildRecommendation(1, "Sub", "staff", { kind: "ineligible", detail: "not a unit of government" })).toEqual({
      call: "PASS",
      verb: "Pass",
      capacity: "Sub",
      conditional: false,
    });
    expect(buildRecommendation(2, "Sub", "client", { kind: "ineligible" })).toBeNull();
  });

  it("no hard kill passed → behaves exactly as before (undefined is inert)", () => {
    expect(buildRecommendation(3, "Prime", "staff", null)).toEqual({ call: "SEND", verb: "Send", capacity: "Prime", conditional: false });
    expect(buildRecommendation(3, "Prime", "staff")).toEqual({ call: "SEND", verb: "Send", capacity: "Prime", conditional: false });
  });
});

describe("buildVerdict", () => {
  it("3 → go; staff names the client, client reads their own advice", () => {
    expect(buildVerdict(3, null, "NWACC", "staff")).toEqual({ call: "go", text: "Go for NWACC." });
    expect(buildVerdict(3, null, "NWACC", "client")).toEqual({ call: "go", text: "Worth pursuing." });
  });

  it("2 → marginal on both sides (client-safe advice)", () => {
    expect(buildVerdict(2, null, "NWACC", "staff")).toEqual({ call: "marginal", text: "Marginal for NWACC." });
    expect(buildVerdict(2, null, "NWACC", "client")).toEqual({ call: "marginal", text: "Marginal — worth a look." });
  });

  it("1 → no-go, STAFF-ONLY (client sees no lead — a 'not a fit' verdict is never client advice)", () => {
    expect(buildVerdict(1, null, "NWACC", "staff")).toEqual({ call: "no-go", text: "No-go for NWACC." });
    expect(buildVerdict(1, null, "NWACC", "client")).toBeNull();
  });

  it("a closed hard kill leads no-go with the deadline reason, staff-only", () => {
    expect(buildVerdict(3, { kind: "closed" }, "NWACC", "staff")).toEqual({
      call: "no-go",
      text: "No-go for NWACC: the deadline has passed.",
    });
    // A hard kill is a no-go, and a no-go is never shown to the client.
    expect(buildVerdict(3, { kind: "closed" }, "NWACC", "client")).toBeNull();
  });

  it("an ineligible hard kill states the gate's own reason (never fabricated)", () => {
    expect(buildVerdict(1, { kind: "ineligible", detail: "not a unit of local government" }, "NWACC", "staff")).toEqual({
      call: "no-go",
      text: "No-go for NWACC: ineligible — not a unit of local government.",
    });
  });

  it("an ineligible kill with no detail falls back to a bare 'for this program'", () => {
    expect(buildVerdict(1, { kind: "ineligible" }, "NWACC", "staff")).toEqual({
      call: "no-go",
      text: "No-go for NWACC: ineligible for this program.",
    });
    // A blank/whitespace detail is treated as absent, not interpolated as an empty reason.
    expect(buildVerdict(1, { kind: "ineligible", detail: "   " }, "NWACC", "staff")).toEqual({
      call: "no-go",
      text: "No-go for NWACC: ineligible for this program.",
    });
  });

  it("blank client name falls back to 'this client' (never an empty name)", () => {
    expect(buildVerdict(3, null, "   ", "staff")).toEqual({ call: "go", text: "Go for this client." });
  });

  it("no score and no hard kill → no lead", () => {
    expect(buildVerdict(null, null, "NWACC", "staff")).toBeNull();
  });
});
