import { describe, it, expect, afterEach } from "vitest";
import { isRoutingCandidate, applySeatJudgment, type SeatJudgment } from "./subseat-routing";
import type { MatchResult } from "./engine";
import type { Client, Grant } from "@/types/database";

// These tests prove the PLUMBING only — the deterministic guards and the code-side mutation. They
// FAKE the SeatJudgment, so they do NOT prove the scoped model call's judgments are correct; that is
// the human-review gate (reading real scoped-call outputs on representative pairs). Green here means
// "the routing mechanics are reliable", not "the fix works end to end".

const FLAG = "MATCH_SUBSEAT_ROUTING_ENABLED";

const profileWithSeat = {
  core_funded_role: "direct service",
  summary: "gov-led consortium",
  archetypes: [
    {
      label: "County government hub",
      ideal_prime_shape: "county government",
      core_role: "coordination",
      partner_seats: ["Direct service co-implementer -- community-based provider"],
    },
  ],
};
const profileNoSeat = {
  core_funded_role: "direct service",
  summary: "gov-led, no partner seats enumerated",
  archetypes: [
    { label: "County government hub", ideal_prime_shape: "county government", core_role: "coordination", partner_seats: [] },
  ],
};

const mkMatch = (over: Partial<MatchResult> = {}): MatchResult =>
  ({
    seat_ref: "NONE",
    fit_score: 0,
    proposed_role: "Not Recommended",
    recommended_prime: null,
    before_you_approve: [],
    reasoning_context: { fit_score_derivation: "engine reasoning" },
    suppressed: false,
    disqualified: true,
    ...over,
  }) as MatchResult;

const mkClient = (over: Partial<Client> = {}): Client =>
  ({
    name: "Test Client",
    org_type: "nonprofit",
    matching_rules: null,
    known_constraints: null,
    client_profile: null,
    ...over,
  }) as Client;

const mkGrant = (over: Partial<Grant> = {}): Grant =>
  ({
    title: "Test Grant",
    subaward_prohibited: false,
    ideal_applicant_profile: profileWithSeat,
    ...over,
  }) as Grant;

const fills = (over: Partial<SeatJudgment> = {}): SeatJudgment => ({
  fills: true,
  seat_ref: "S0_0",
  seat_function: "direct service co-implementer",
  prime_type: "county government",
  defers_to_client_rule: false,
  rationale: "genuine functional match",
  ...over,
});

describe("isRoutingCandidate — the DEFER-FIRST guards (identity unless ALL pass; no model call otherwise)", () => {
  afterEach(() => {
    delete process.env[FLAG];
  });

  it("flag OFF → not a candidate (so routeSupportingSeat is identity and makes no second call)", () => {
    delete process.env[FLAG];
    expect(isRoutingCandidate(mkMatch(), mkClient(), mkGrant())).toBe(false);
    process.env[FLAG] = ""; // present-but-blank is also off
    expect(isRoutingCandidate(mkMatch(), mkClient(), mkGrant())).toBe(false);
  });

  it("suppressed match → not a candidate (suppression is never touched)", () => {
    process.env[FLAG] = "true";
    expect(isRoutingCandidate(mkMatch({ suppressed: true }), mkClient(), mkGrant())).toBe(false);
  });

  it("subaward_prohibited grant → not a candidate (no sub structure)", () => {
    process.env[FLAG] = "true";
    expect(isRoutingCandidate(mkMatch(), mkClient(), mkGrant({ subaward_prohibited: true }))).toBe(false);
  });

  it("for-profit / federal client → not a candidate (HARD ROLE RULES own those)", () => {
    process.env[FLAG] = "true";
    expect(isRoutingCandidate(mkMatch(), mkClient({ org_type: "For-Profit / Commercial" }), mkGrant())).toBe(false);
    expect(isRoutingCandidate(mkMatch(), mkClient({ org_type: "Federal agency" }), mkGrant())).toBe(false);
  });

  it("already seated (a real seat, not disqualified) → not a candidate", () => {
    process.env[FLAG] = "true";
    expect(isRoutingCandidate(mkMatch({ seat_ref: "P0", disqualified: false }), mkClient(), mkGrant())).toBe(false);
    expect(isRoutingCandidate(mkMatch({ seat_ref: "S0_0", disqualified: false }), mkClient(), mkGrant())).toBe(false);
  });

  it("no supporting seat in the profile → not a candidate (nothing to route to)", () => {
    process.env[FLAG] = "true";
    expect(isRoutingCandidate(mkMatch(), mkClient(), mkGrant({ ideal_applicant_profile: profileNoSeat }))).toBe(false);
  });

  it("disqualified nonprofit on a sub-permitting grant with a supporting seat → candidate", () => {
    process.env[FLAG] = "true";
    expect(isRoutingCandidate(mkMatch({ disqualified: true }), mkClient(), mkGrant())).toBe(true);
    // A NONE seat that was not hard-disqualified is still unseated → candidate.
    expect(isRoutingCandidate(mkMatch({ seat_ref: "NONE", disqualified: false }), mkClient(), mkGrant())).toBe(true);
  });
});

describe("applySeatJudgment — the code-side mutation (given a faked judgment)", () => {
  it("routes a genuine seat: seat/role/fit(=2)/disqualified/prime/flag/reasoning all set", () => {
    const m = mkMatch();
    applySeatJudgment(m, mkClient(), mkGrant(), fills());
    expect(m.seat_ref).toBe("S0_0");
    expect(m.proposed_role).toBe("Sub");
    expect(m.fit_score).toBe(2); // supporting-seat floor / ceiling
    expect(m.disqualified).toBe(false);
    expect(m.recommended_prime).toBe("county government");
    expect(m.before_you_approve[0]).toContain("Prime applicant needed");
    expect(m.reasoning_context?.fit_score_derivation).toContain("Supporting-seat routing");
    expect(m.reasoning_context?.fit_score_derivation).toContain("engine reasoning"); // prior reasoning kept
  });

  it("prepends the prime-gap flag, preserving existing before_you_approve items", () => {
    const m = mkMatch({ before_you_approve: ["existing flag"] });
    applySeatJudgment(m, mkClient(), mkGrant(), fills());
    expect(m.before_you_approve[0]).toContain("Prime applicant needed");
    expect(m.before_you_approve).toContain("existing flag");
  });

  it("never touches `suppressed`", () => {
    const supp = mkMatch({ suppressed: true });
    applySeatJudgment(supp, mkClient(), mkGrant(), fills());
    expect(supp.suppressed).toBe(true); // routing must never flip suppression, in either direction
  });

  it("defers to a legitimate client rule → identity (never overrides a real client decline)", () => {
    const m = mkMatch();
    applySeatJudgment(m, mkClient(), mkGrant(), fills({ defers_to_client_rule: true }));
    expect(m.seat_ref).toBe("NONE");
    expect(m.disqualified).toBe(true);
    expect(m.fit_score).toBe(0);
  });

  it("does not route when the judgment says the seat is not filled → identity", () => {
    const m = mkMatch();
    applySeatJudgment(m, mkClient(), mkGrant(), fills({ fills: false }));
    expect(m.seat_ref).toBe("NONE");
    expect(m.disqualified).toBe(true);
  });

  it("does not route without a named seat id → identity", () => {
    const m = mkMatch();
    applySeatJudgment(m, mkClient(), mkGrant(), fills({ seat_ref: null }));
    expect(m.seat_ref).toBe("NONE");
    applySeatJudgment(m, mkClient(), mkGrant(), fills({ seat_ref: "NONE" }));
    expect(m.seat_ref).toBe("NONE");
  });

  it("does not route a PRIME seat id → identity (the model must name a real SUPPORTING seat)", () => {
    const m = mkMatch();
    applySeatJudgment(m, mkClient(), mkGrant(), fills({ seat_ref: "P0" }));
    expect(m.seat_ref).toBe("NONE"); // P0 is a prime seat, not a partner seat → not a sub routing
    expect(m.disqualified).toBe(true);
  });

  it("does not route a hallucinated / non-existent seat id → identity", () => {
    const m = mkMatch();
    applySeatJudgment(m, mkClient(), mkGrant(), fills({ seat_ref: "S9_9" }));
    expect(m.seat_ref).toBe("NONE"); // not in this grant's menu → bail
    expect(m.disqualified).toBe(true);
  });
});
