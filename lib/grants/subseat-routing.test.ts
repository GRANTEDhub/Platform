import { describe, it, expect, afterEach } from "vitest";
import { isRoutingCandidate, applySeatJudgment, routeSupportingSeat, clientContextForJudge, type SeatJudgment } from "./subseat-routing";
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
  disqualification_is_prime_ineligibility_only: true, // clean prime-ineligible-only → routable
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

describe("applySeatJudgment — the SOLE-BARRIER gate (#408 disqualify-reason-blind fix)", () => {
  // These fake the judgment, so they prove the CODE defers correctly given the flag the scoped prompt
  // is designed to set. Whether the judge actually returns false for a DUAL disqualification (Harbor
  // House) is the scoped-prompt's quality — the human-review gate, same as the plumbing-vs-judgment
  // caveat at the top of this file. What is proven here: a false flag can NEVER route, in every shape.

  it("clean prime-ineligibility ONLY (a specialist on a government-only NOFO) → routes to Sub", () => {
    // The intended win: prime-entity-ineligibility is the sole barrier, so the sub-capable specialist
    // is routed to its genuine supporting seat.
    const m = mkMatch({ disqualify_reason: "Nonprofit excluded — government-only NOFO (prime must be a unit of government)." });
    applySeatJudgment(m, mkClient(), mkGrant(), fills({ disqualification_is_prime_ineligibility_only: true }));
    expect(m.seat_ref).toBe("S0_0");
    expect(m.proposed_role).toBe("Sub");
    expect(m.fit_score).toBe(2);
    expect(m.disqualified).toBe(false);
  });

  it("LANDMINE — Harbor House DUAL disqualification (prime-ineligible + capital-only client rule) → does NOT route", () => {
    // The concrete case Approach A would misfire on: a code classifier sees the prime-ineligibility
    // phrase and routes; the judge reads BOTH barriers and sets the flag false. A second, independent
    // barrier (the client's own capital-only matching rule) must not be resurrected into a Sub seat.
    const m = mkMatch({
      disqualify_reason:
        "Dual disqualification: (1) nonprofit excluded, government-only NOFO; (2) matching rule prohibits program-only grants without a capital component.",
    });
    applySeatJudgment(m, mkClient(), mkGrant(), fills({ disqualification_is_prime_ineligibility_only: false }));
    expect(m.seat_ref).toBe("NONE"); // identity — un-routed
    expect(m.disqualified).toBe(true);
    expect(m.fit_score).toBe(0);
    expect(m.proposed_role).toBe("Not Recommended");
  });

  it("geo-disqualified org (the reason-blindness bug) → does NOT route, even with a genuinely filled seat", () => {
    // Reason-blindness was routing on a geography kill. The seat is genuinely filled (fills=true, real
    // S0_0), but the barrier is geographic, so the flag is false and the gate holds.
    const m = mkMatch({ disqualify_reason: "Client service area does not serve the eligible region (grant restricted to the Lake Superior Basin)." });
    applySeatJudgment(m, mkClient(), mkGrant(), fills({ fills: true, seat_ref: "S0_0", disqualification_is_prime_ineligibility_only: false }));
    expect(m.seat_ref).toBe("NONE");
    expect(m.disqualified).toBe(true);
    expect(m.fit_score).toBe(0);
  });

  it("the sole-barrier gate composes with (does not replace) the other guards", () => {
    // A true flag still cannot route past the pre-existing guards — fills=false wins, defers wins.
    const a = mkMatch();
    applySeatJudgment(a, mkClient(), mkGrant(), fills({ disqualification_is_prime_ineligibility_only: true, fills: false }));
    expect(a.seat_ref).toBe("NONE");
    const b = mkMatch();
    applySeatJudgment(b, mkClient(), mkGrant(), fills({ disqualification_is_prime_ineligibility_only: true, defers_to_client_rule: true }));
    expect(b.seat_ref).toBe("NONE");
  });
});

describe("clientContextForJudge — PROFILE-FREE occupancy (#413, invariant #138→#140)", () => {
  // Locks the leak closed: the scoped occupancy judge must see the SAME raw client fields the main
  // scorer uses (name, org type, location, service area, funding needs, rules/constraints) and NEVER
  // client_profile (Mission / core_capabilities / supporting_roles). Same discipline as the main
  // scorer's profileInvariant guard.
  it("emits the raw scorer substrate and NEVER leaks any client_profile value", () => {
    const c = {
      name: "Recovery Org",
      org_type: "nonprofit",
      location_city: "Fayetteville",
      location_county: "Washington",
      location_state: "AR",
      service_area: ["Northwest Arkansas"],
      primary_funding_needs: ["SUD recovery services", "capital"],
      matching_rules: "Capital-first: do not surface program-only grants.",
      known_constraints: "Capital-focused only.",
      // Present, but MUST NOT reach the occupancy judge — narrative enrichment only.
      client_profile: {
        mission: "PROFILE_MISSION_SECRET",
        core_capabilities: "PROFILE_CAPS_SECRET",
        supporting_roles: "PROFILE_ROLES_SECRET",
      },
    } as unknown as Client;
    const ctx = clientContextForJudge(c);

    // Raw scorer substrate present (mirrors engine.ts clientContext)
    expect(ctx).toContain("Recovery Org");
    expect(ctx).toContain("nonprofit");
    expect(ctx).toContain("Fayetteville, Washington, AR");
    expect(ctx).toContain("Northwest Arkansas");
    expect(ctx).toContain("SUD recovery services, capital");
    expect(ctx).toContain("Capital-first"); // matching_rules kept — the DEFER check needs it
    expect(ctx).toContain("Capital-focused only"); // known_constraints kept

    // client_profile values NEVER leak into the occupancy judge
    expect(ctx).not.toContain("PROFILE_MISSION_SECRET");
    expect(ctx).not.toContain("PROFILE_CAPS_SECRET");
    expect(ctx).not.toContain("PROFILE_ROLES_SECRET");
  });

  it("omits empty raw fields cleanly (no dangling labels) and still never touches the profile", () => {
    const c = {
      name: "Thin Client",
      org_type: null,
      service_area: null,
      primary_funding_needs: null,
      matching_rules: null,
      known_constraints: null,
      client_profile: { mission: "STILL_SECRET" },
    } as unknown as Client;
    const ctx = clientContextForJudge(c);
    expect(ctx).toContain("Thin Client");
    expect(ctx).toContain("Entity type: unknown");
    expect(ctx).not.toContain("Service area:"); // empty → line omitted
    expect(ctx).not.toContain("Primary funding needs:");
    expect(ctx).not.toContain("STILL_SECRET");
  });
});

describe("routeSupportingSeat — resilience: a thrown scoped call falls back, never throws or mutates", () => {
  afterEach(() => {
    delete process.env[FLAG];
  });

  it("scoped-call failure → falls back to the un-routed result (never throws; result unchanged)", async () => {
    process.env[FLAG] = "true";
    // Force the scoped second call to throw WITHOUT a real API call: getAnthropicClient() throws on a
    // missing key, so judgeSupportingSeat throws -- exercising the exact rate-limit/network/5xx path.
    const savedKey = process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    try {
      const m = mkMatch(); // disqualified / NONE -> a genuine routing candidate (isRoutingCandidate=true)
      await expect(routeSupportingSeat(m, mkClient(), mkGrant())).resolves.toBeUndefined(); // never throws
      // Fell back to the pre-routing result -- UNCHANGED, this pair simply is not sub-routed.
      expect(m.seat_ref).toBe("NONE");
      expect(m.disqualified).toBe(true);
      expect(m.fit_score).toBe(0);
      expect(m.proposed_role).toBe("Not Recommended");
      expect(m.suppressed).toBe(false); // suppression untouched, as always
    } finally {
      if (savedKey !== undefined) process.env.ANTHROPIC_API_KEY = savedKey;
      else delete process.env.ANTHROPIC_API_KEY;
    }
  });
});
