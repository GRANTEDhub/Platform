import { describe, it, expect, afterEach } from "vitest";
import {
  isNexusCandidate,
  nexusFlagFromJudgment,
  evaluateGenericNexus,
  type NexusJudgment,
} from "./generic-nexus";
import type { MatchResult } from "./engine";
import type { Client, Grant } from "@/types/database";

// Deterministic tests for the generic-over-specific demotion tag. They prove the PLUMBING — the
// candidate guard (fit-2-only, seated, flag-gated), the pure existence-test applier, and the
// byte-identical-OFF / no-model-call guarantee. They FAKE the NexusJudgment, so they do NOT prove the
// scoped call's classification is correct; that is the model-in-the-loop gate (generic-nexus.eval.test.ts),
// which MUST pass before the flag is flipped. Green here means "the demote mechanics are reliable".

const FLAG = "MATCH_GENERIC_NEXUS_GATE_ENABLED";

const mkMatch = (over: Partial<MatchResult> = {}): MatchResult =>
  ({
    seat_ref: "P0",
    fit_score: 2,
    proposed_role: "Prime",
    before_you_approve: [],
    inferred_fields: [],
    reasoning_context: { fit_score_derivation: "engine reasoning", eligibility_analysis: "" },
    suppressed: false,
    disqualified: false,
    ...over,
  }) as MatchResult;

const mkClient = (over: Partial<Client> = {}): Client =>
  ({ name: "Test Client", org_type: "nonprofit", client_profile: null, ...over }) as Client;

const mkGrant = (over: Partial<Grant> = {}): Grant =>
  ({ id: "g1", title: "Test Grant", ideal_applicant_profile: null, ...over }) as Grant;

// The two canonical judgment shapes from the real rows.
const inferred = (over: Partial<NexusJudgment> = {}): NexusJudgment => ({
  qualifying_dimension: "in-facility correctional education",
  basis: "inferred_from_adjacency",
  rationale:
    "The correctional-education nexus is inferred from applied/workforce mission alignment; no confirmed " +
    "prior programming inside a correctional facility. (Execution caveats — no federal grant history, MOU " +
    "not signed, SAM, budget — also present, but the dimension itself is unconfirmed.)",
  ...over,
});
const entailed = (over: Partial<NexusJudgment> = {}): NexusJudgment => ({
  qualifying_dimension: "body-worn-camera program",
  basis: "entailed_by_identity",
  rationale:
    "The county sheriff's office is a confirmed law-enforcement entity; a BWC program is a new instance. " +
    "The caps are execution-only: no DOJ grant history, SAM unknown, match capacity low.",
  ...over,
});

describe("isNexusCandidate — demote-within-2 only, flag-gated, seated (identity otherwise)", () => {
  afterEach(() => {
    delete process.env[FLAG];
  });

  it("flag OFF → never a candidate, whatever the score (byte-identical to today; no model call)", () => {
    delete process.env[FLAG];
    expect(isNexusCandidate(mkMatch({ fit_score: 2 }))).toBe(false);
    process.env[FLAG] = "false";
    expect(isNexusCandidate(mkMatch({ fit_score: 2 }))).toBe(false);
  });

  it("flag ON + seated conditional-2 → candidate", () => {
    process.env[FLAG] = "true";
    expect(isNexusCandidate(mkMatch({ fit_score: 2, seat_ref: "P1" }))).toBe(true);
    expect(isNexusCandidate(mkMatch({ fit_score: 2, seat_ref: "S0_3" }))).toBe(true);
  });

  it("fit 3 (clean/strong) and fit < 2 (does not surface) → NOT candidates", () => {
    process.env[FLAG] = "true";
    expect(isNexusCandidate(mkMatch({ fit_score: 3 }))).toBe(false);
    expect(isNexusCandidate(mkMatch({ fit_score: 1 }))).toBe(false);
    expect(isNexusCandidate(mkMatch({ fit_score: 0 }))).toBe(false);
  });

  it("suppressed / disqualified / seat NONE → NOT candidates (hard-gated or unseated)", () => {
    process.env[FLAG] = "true";
    expect(isNexusCandidate(mkMatch({ fit_score: 2, suppressed: true }))).toBe(false);
    expect(isNexusCandidate(mkMatch({ fit_score: 2, disqualified: true }))).toBe(false);
    expect(isNexusCandidate(mkMatch({ fit_score: 2, seat_ref: "NONE" }))).toBe(false);
  });
});

describe("nexusFlagFromJudgment — the EXISTENCE TEST (one inferred-nexus caveat decides it)", () => {
  it("inferred_from_adjacency → flagged, with the dimension named in the lead note", () => {
    const f = nexusFlagFromJudgment(inferred());
    expect(f.flagged).toBe(true);
    expect(f.note).toContain("GENERIC-OVER-SPECIFIC");
    expect(f.note).toContain("in-facility correctional education");
  });

  it("NWACC-mixed shape: the nexus caveat sits beside FOUR execution caveats → still flagged (existence, not purity)", () => {
    // The rationale explicitly carries MOU / federal-history / SAM / budget alongside the one inferred
    // dimension. The applier keys on `basis` alone — surrounding execution caveats never dilute it.
    const f = nexusFlagFromJudgment(
      inferred({ rationale: "MOU pending; no federal grant history; SAM expiring; budget unknown; AND correctional history unverified." }),
    );
    expect(f.flagged).toBe(true);
  });

  it("entailed_by_identity (Columbia-BWC execution-only) → NOT flagged (identity)", () => {
    const f = nexusFlagFromJudgment(entailed());
    expect(f.flagged).toBe(false);
    expect(f.note).toBeNull();
  });

  it("a blank/absent dimension on an inferred basis still flags, with a safe fallback phrase", () => {
    const f = nexusFlagFromJudgment(inferred({ qualifying_dimension: "  " }));
    expect(f.flagged).toBe(true);
    expect(f.note).toContain("the specific qualifying dimension");
  });
});

describe("evaluateGenericNexus — the guard prevents any model call off the candidate path", () => {
  afterEach(() => {
    delete process.env[FLAG];
  });

  it("flag OFF + conditional-2 → IDENTITY without a model call (byte-identical OFF)", async () => {
    delete process.env[FLAG];
    // getAnthropicClient is never reached because isNexusCandidate short-circuits on the flag; if it
    // WERE reached with no ANTHROPIC_API_KEY this would throw, so a clean identity return is the proof.
    await expect(evaluateGenericNexus(mkMatch({ fit_score: 2 }), mkClient(), mkGrant())).resolves.toEqual({
      flagged: false,
      note: null,
    });
  });

  it("flag ON but fit 3 (non-candidate) → IDENTITY without a model call", async () => {
    process.env[FLAG] = "true";
    await expect(evaluateGenericNexus(mkMatch({ fit_score: 3 }), mkClient(), mkGrant())).resolves.toEqual({
      flagged: false,
      note: null,
    });
  });
});
