import { describe, it, expect, afterEach } from "vitest";
import { applyMissionGate, isMissionBasedReason } from "./mission-gate";
import { isRoutingCandidate } from "./subseat-routing";
import type { MatchResult } from "./engine";
import type { Client, Grant } from "@/types/database";

// Deterministic tests: the classifier, the gate's guards + mutation, and — most importantly — the
// INTERACTION with the already-live sub-routing fix (#408). No model call. Green here proves the
// PLUMBING and the ORDERING are sound; whether real counties actually trip all three signals (and
// thin-profile fits do not) is the empirical flip-gate, covered by mission-gate.eval.test.ts.

const MISSION_FLAG = "MATCH_MISSION_GATE_ENABLED";
const SUBSEAT_FLAG = "MATCH_SUBSEAT_ROUTING_ENABLED";

const mkMatch = (over: Partial<MatchResult> = {}): MatchResult =>
  ({
    seat_ref: "NONE",
    fit_score: 0,
    proposed_role: "Not Recommended",
    recommended_prime: null,
    before_you_approve: [],
    reasoning_context: { fit_score_derivation: "engine reasoning" },
    suppressed: false,
    suppress_reason: null,
    disqualified: true,
    disqualify_reason: "Purpose alignment (Gate 4) fails — topical/mission adjacency only, no genuine seat.",
    ...over,
  }) as MatchResult;

// A grant with a genuine SUPPORTING (partner) seat — the shape sub-routing needs to consider routing.
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
const mkClient = (over: Partial<Client> = {}): Client =>
  ({ name: "Test Client", org_type: "nonprofit", matching_rules: null, known_constraints: null, client_profile: null, ...over }) as Client;
const mkGrant = (over: Partial<Grant> = {}): Grant =>
  ({ title: "Test Grant", subaward_prohibited: false, ideal_applicant_profile: profileWithSeat, ...over }) as Grant;

describe("isMissionBasedReason — signal 3 (fails toward NOT suppressing)", () => {
  it("matches genuine Gate-4 mission / purpose reasons", () => {
    for (const r of [
      "Purpose alignment (Gate 4) fails — topical/mission adjacency only, no genuine seat.",
      "The client's mission is unrelated to this program; mission adjacency at best.",
      "Program scope/purpose not aligned: the org does not perform this kind of work.",
      "No programmatic overlap — this falls outside the organization's core services.",
      "Served population mismatch; the grant's program intent does not fit what this client does.",
      "Does not operate any relevant program in this domain; adjacency only.",
    ]) {
      expect(isMissionBasedReason(r), r).toBe(true);
    }
  });

  it("does NOT match entity-type / geography / deadline / award-size reasons (these stay sub-routable)", () => {
    for (const r of [
      "Entity type ineligible (Gate 2): counties are not in the eligible entity list; only nonprofits may apply.",
      "This program is limited to state agencies as recipients.", // 'program' here is the GRANT's — must not fire
      "Geography (Gate 3): the client's service area is entirely outside the eligible HUC watershed.",
      "Deadline viability: closes in 5 days.",
      "Award size exceeds the client's delivery capacity.",
      "For-profit entity — route to facilitator only.",
    ]) {
      expect(isMissionBasedReason(r), r).toBe(false);
    }
  });

  it("empty / null / whitespace reason → false (cannot confirm mission → do not suppress)", () => {
    expect(isMissionBasedReason(null)).toBe(false);
    expect(isMissionBasedReason(undefined)).toBe(false);
    expect(isMissionBasedReason("   ")).toBe(false);
  });

  it("bare 'no seat' phrasing does NOT by itself read as mission (that is signal 2, and firing on it would block sub-routable specialists)", () => {
    expect(isMissionBasedReason("No seat: prime-ineligible on entity type.")).toBe(false);
    expect(isMissionBasedReason("seat_ref = NONE; not an eligible prime.")).toBe(false);
  });
});

describe("applyMissionGate — the strict three-signal bar (identity unless ALL hold)", () => {
  afterEach(() => {
    delete process.env[MISSION_FLAG];
  });

  it("flag OFF → identity (no mutation; the instant kill-switch)", () => {
    delete process.env[MISSION_FLAG];
    const m = mkMatch();
    applyMissionGate(m);
    expect(m.suppressed).toBe(false);
    process.env[MISSION_FLAG] = ""; // present-but-blank is also off
    applyMissionGate(m);
    expect(m.suppressed).toBe(false);
  });

  it("flag ON + all three signals (disqualified + NONE + mission reason) → suppressed with an explainable reason", () => {
    process.env[MISSION_FLAG] = "true";
    const m = mkMatch();
    applyMissionGate(m);
    expect(m.suppressed).toBe(true);
    expect(m.suppress_reason).toContain("Mission gate");
    expect(m.disqualified).toBe(true); // never touched
    expect(m.fit_score).toBe(0); // never lowered/raised — the gate only suppresses
  });

  it("signal 1 missing (not disqualified) → identity, even with a mission-shaped reason", () => {
    process.env[MISSION_FLAG] = "true";
    const m = mkMatch({ disqualified: false });
    applyMissionGate(m);
    expect(m.suppressed).toBe(false);
  });

  it("signal 2 missing (holds a real seat) → identity — a thin-profile genuine fit is preserved", () => {
    process.env[MISSION_FLAG] = "true";
    const seated = mkMatch({ seat_ref: "S0_0", disqualified: false, fit_score: 2, proposed_role: "Sub" });
    applyMissionGate(seated);
    expect(seated.suppressed).toBe(false);
    expect(seated.fit_score).toBe(2); // still surfaces
  });

  it("signal 3 missing (entity-type reason, not mission) → identity — stays available to the sub-router", () => {
    process.env[MISSION_FLAG] = "true";
    const m = mkMatch({ disqualify_reason: "Entity type ineligible (Gate 2): only nonprofits may prime." });
    applyMissionGate(m);
    expect(m.suppressed).toBe(false);
  });

  it("already suppressed → identity (never re-touched, never un-suppressed)", () => {
    process.env[MISSION_FLAG] = "true";
    const m = mkMatch({ suppressed: true, suppress_reason: "prior reason" });
    applyMissionGate(m);
    expect(m.suppressed).toBe(true);
    expect(m.suppress_reason).toBe("prior reason"); // untouched
  });
});

// ── The interaction the user gated the merge on: mission-gate vs. sub-routing (#408), both flags ON ──
describe("interaction with sub-routing (#408) — ordering is clean, no fight possible", () => {
  afterEach(() => {
    delete process.env[MISSION_FLAG];
    delete process.env[SUBSEAT_FLAG];
  });

  it("mission-disqualified + prime-ineligible: mission-gate suppresses → sub-router refuses to touch it (no resurrection)", () => {
    process.env[MISSION_FLAG] = "true";
    process.env[SUBSEAT_FLAG] = "true";
    // A sub-capable nonprofit, disqualified with a MISSION reason, NONE seat, on a sub-permitting grant
    // that HAS a supporting seat — i.e. a case the sub-router WOULD otherwise consider routing.
    const m = mkMatch();
    const client = mkClient();
    const grant = mkGrant();

    // Before the gate runs, this IS a sub-routing candidate (that is the whole risk).
    expect(isRoutingCandidate(m, client, grant)).toBe(true);

    // matchGrantToClient runs the mission-gate FIRST (engine.ts), then routeSupportingSeat.
    applyMissionGate(m);
    expect(m.suppressed).toBe(true);

    // Now the sub-router bails on result.suppressed → it makes NO second call and NO mutation.
    // A confident mission-disqualify can never be resurrected into a Sub seat.
    expect(isRoutingCandidate(m, client, grant)).toBe(false);
  });

  it("prime-ineligible on ENTITY grounds (not mission): mission-gate is identity → sub-router still owns it (population preserved)", () => {
    process.env[MISSION_FLAG] = "true";
    process.env[SUBSEAT_FLAG] = "true";
    // Same shape, but the disqualify is entity-type, not mission — this is exactly sub-routing's job.
    const m = mkMatch({ disqualify_reason: "Entity type: prime-ineligible on a gov-only NOFO." });
    const client = mkClient();
    const grant = mkGrant();

    applyMissionGate(m);
    expect(m.suppressed).toBe(false); // the mission-gate does NOT cannibalize the sub-router's population
    expect(isRoutingCandidate(m, client, grant)).toBe(true); // sub-router still gets to route it
  });
});
