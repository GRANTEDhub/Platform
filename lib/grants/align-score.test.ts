import { afterEach, describe, expect, it } from "vitest";
import {
  matchDirectAlignEnabled,
  seatRefForRole,
  buildAlignUserContent,
  finalizeAlignMatch,
  alignScoreClient,
} from "./align-score";
import { formatClientProfileForScoring } from "@/lib/clients/profile";
import type { Client, Grant, ClientProfile } from "@/types/database";

// Deterministic tests for the direct-alignment scorer. They FAKE the model, so they prove the PLUMBING --
// the flag reader, the role->seat_ref derivation, the scoring-facing profile formatter, the coercion +
// KEPT hard-constraint / email post-processing, and the injected-model wiring. They do NOT prove the
// scoring is CORRECT; that is the model-in-the-loop gate (align-score.eval.test.ts), which MUST pass
// before MATCH_DIRECT_ALIGN_ENABLED is flipped. Green here means "the swap mechanics are reliable".

const FLAG = "MATCH_DIRECT_ALIGN_ENABLED";
afterEach(() => {
  delete process.env[FLAG];
});

const mkClient = (over: Partial<Client> = {}): Client =>
  ({
    id: "c1",
    name: "Test Org",
    primary_contact_name: "Dana",
    org_type: "nonprofit",
    engagement_tier: "Navigate",
    location_city: "Bentonville",
    location_county: "Benton",
    location_state: "AR",
    service_area: ["AR -- Statewide"],
    rucc_codes: null,
    annual_budget: null,
    primary_funding_needs: ["Program expansion"],
    project_stage: null,
    match_cost_share_capacity: null,
    federal_grant_history: null,
    known_constraints: null,
    matching_rules: null,
    hard_constraints: null,
    client_profile: null,
    ...over,
  }) as unknown as Client;

const mkGrant = (over: Partial<Grant> = {}): Grant =>
  ({
    id: "g1",
    title: "Test Grant",
    funder: "USDA",
    fon: "USDA-2026-001",
    description: "Funds direct habitat restoration by field implementers.",
    ideal_applicant_profile: null,
    award_range_min: "$100,000",
    award_range_max: "$500,000",
    total_funding: "$5,000,000",
    submission_deadline: "2026-12-01",
    cost_share: "None",
    eligible_entity_types: ["Nonprofits 501(c)(3)"],
    geographic_eligibility: "United States",
    ineligible_entities: "",
    focus_areas: ["Environment"],
    program_type: "Competitive Grant",
    delivery_model: "direct service",
    subaward_prohibited: false,
    scoring_criteria_high_value: [],
    ...over,
  }) as unknown as Grant;

const mkProfile = (over: Partial<ClientProfile> = {}): ClientProfile =>
  ({
    summary: "A regional nonprofit.",
    mission: "Serve the community.",
    core_capabilities: ["Direct service delivery"],
    program_areas: [],
    populations_served: ["Rural residents"],
    geographic_scope: { footprint: "Northwest Arkansas", scale: "regional", states: ["AR"] },
    prime_capacity: { can_prime: true, rationale: "Performs the core funded role." },
    supporting_roles: [],
    partnerships: [],
    funding_priorities: [],
    federal_history: { self_reported: "None" },
    inferred: [],
    gaps: [],
    ...over,
  }) as ClientProfile;

// A full, valid submit_match tool output (the model's raw input), overridable per test.
const mkRaw = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  fit_score: 2,
  proposed_role: "Prime",
  recommended_prime: null,
  why_this_org: ["Genuine fit."],
  concept_synopsis: "A concept.",
  description_short: "Short desc.",
  draft_outreach_email: "Dear Dana,\n\nWorth a look.",
  outreach_track: "Track 1",
  before_you_approve: ["Confirm SAM.gov is active."],
  inferred_fields: [],
  reasoning_context: {
    eligibility_analysis: "Eligible as a nonprofit.",
    fit_score_derivation: "Conditional fit.",
    role_assignment_logic: "Prime.",
    consortium_rationale: "n/a",
    concept_derivation: "n/a",
    why_not_others: "n/a",
  },
  factor_scores: {
    seat_role: { rating: "strong", rationale: "r" },
    eligibility: { rating: "strong", rationale: "r" },
    geographic: { rating: "moderate", rationale: "r" },
    program_history: { rating: "insufficient_data", rationale: "r" },
    cost_share: { rating: "insufficient_data", rationale: "r" },
    mission: { rating: "strong", rationale: "r" },
  },
  suppressed: false,
  suppress_reason: null,
  disqualified: false,
  disqualify_reason: null,
  ...over,
});

describe("direct-alignment scorer -- plumbing", () => {
  it("matchDirectAlignEnabled is true ONLY when the env flag is exactly 'true' (byte-identical OFF)", () => {
    delete process.env[FLAG];
    expect(matchDirectAlignEnabled()).toBe(false);
    process.env[FLAG] = "1";
    expect(matchDirectAlignEnabled()).toBe(false);
    process.env[FLAG] = "TRUE";
    expect(matchDirectAlignEnabled()).toBe(false);
    process.env[FLAG] = "true";
    expect(matchDirectAlignEnabled()).toBe(true);
  });

  it("derives the seat_ref FAMILY from the role so calibration's seatFamily still classifies the card", () => {
    expect(seatRefForRole("Prime")).toBe("P0");
    expect(seatRefForRole("Co-Applicant")).toBe("S0");
    expect(seatRefForRole("Sub")).toBe("S0");
    expect(seatRefForRole("Named Collaborator")).toBe("S0");
    expect(seatRefForRole("Facilitator")).toBe("NONE");
    expect(seatRefForRole("Letter of Support")).toBe("NONE");
    expect(seatRefForRole("Not Recommended")).toBe("NONE");
    expect(seatRefForRole(null)).toBe("NONE");
    expect(seatRefForRole("")).toBe("NONE");
  });

  it("the scoring formatter LEADS with can_prime, includes core_capabilities, and is empty for a null profile", () => {
    expect(formatClientProfileForScoring(null)).toBe("");
    const out = formatClientProfileForScoring(
      mkProfile({
        prime_capacity: { can_prime: false, rationale: "A fundraising foundation, not an implementer." },
        core_capabilities: ["Fundraising", "Fiscal sponsorship"],
      }),
    );
    expect(out).toContain("can_prime=FALSE");
    expect(out).toContain("Fiscal sponsorship");
    // can_prime must appear BEFORE core_capabilities -- it is the load-bearing lead.
    expect(out.indexOf("can_prime")).toBeGreaterThan(-1);
    expect(out.indexOf("can_prime")).toBeLessThan(out.indexOf("Core capabilities"));
  });

  it("finalizeAlignMatch coerces the model output into a MatchResult with a derived seat_ref", () => {
    const res = finalizeAlignMatch(mkRaw({ fit_score: 3, proposed_role: "Prime" }), mkClient(), mkGrant());
    expect(res.fit_score).toBe(3);
    expect(res.proposed_role).toBe("Prime");
    expect(res.seat_ref).toBe("P0");
    expect(res.entity_required).toBe(false);
    expect(res.client_id).toBe("c1");
  });

  it("clamps an out-of-range score and backfills safe defaults for missing arrays", () => {
    const res = finalizeAlignMatch({ fit_score: 9, proposed_role: "Sub" }, mkClient(), mkGrant());
    expect(res.fit_score).toBe(3);
    expect(res.seat_ref).toBe("S0");
    expect(Array.isArray(res.before_you_approve)).toBe(true);
    expect(Array.isArray(res.why_this_org)).toBe(true);
  });

  it("KEEPS applyHardConstraints: a role_ceiling caps the role + score, and seat_ref follows the CAPPED role", () => {
    const client = mkClient({
      hard_constraints: [
        { type: "role_ceiling", value: "sub", note: "partner only for this client", action: "cap_role" },
      ] as unknown as Client["hard_constraints"],
    });
    const res = finalizeAlignMatch(mkRaw({ fit_score: 3, proposed_role: "Prime" }), client, mkGrant());
    expect(res.proposed_role).toBe("sub");
    expect(res.fit_score).toBeLessThanOrEqual(2);
    // seat_ref must reflect the capped role (S0), not the model's original Prime (P0).
    expect(res.seat_ref).toBe("S0");
  });

  it("sanitizes the drafted outreach email (strips a Subject: line)", () => {
    const res = finalizeAlignMatch(
      mkRaw({ draft_outreach_email: "Subject: Opportunity\n\nDear Dana,\n\nWorth a look." }),
      mkClient({ primary_contact_name: "Dana" }),
      mkGrant(),
    );
    expect(res.draft_outreach_email).not.toContain("Subject:");
  });

  it("buildAlignUserContent carries the client profile + the funded purpose, and NO seat menu", () => {
    const grant = mkGrant({
      ideal_applicant_profile: {
        core_funded_role: "field habitat implementation",
        summary: "built for hands-on implementers",
        archetypes: [],
      } as unknown as Grant["ideal_applicant_profile"],
    });
    const profileText = formatClientProfileForScoring(
      mkProfile({ prime_capacity: { can_prime: false, rationale: "funder" } }),
    );
    const out = buildAlignUserContent(grant, mkClient(), undefined, profileText);
    expect(out).toContain("Funded purpose");
    expect(out).toContain("can_prime=FALSE");
    // The seat/occupancy apparatus is gone -- the prompt must not reintroduce a seat menu.
    expect(out).not.toContain("SEAT MENU");
    expect(out).not.toContain("seat_ref");
  });

  it("alignScoreClient returns the finalized match from an INJECTED model (no network)", async () => {
    const res = await alignScoreClient(mkGrant(), mkClient(), undefined, {
      runModel: async () => mkRaw({ fit_score: 1, proposed_role: "Not Recommended" }),
    });
    expect(res.fit_score).toBe(1);
    expect(res.proposed_role).toBe("Not Recommended");
    expect(res.seat_ref).toBe("NONE");
  });

  it("throws when the model returns no structured tool call (scoreGrantClientPair records an 'error' attempt)", async () => {
    await expect(
      alignScoreClient(mkGrant(), mkClient(), undefined, { runModel: async () => null }),
    ).rejects.toThrow();
  });

  it("restores the #105 factor-data floor: blank client fields force insufficient_data (parity with the occupancy path)", () => {
    const blankClient = mkClient({
      annual_budget: null,
      match_cost_share_capacity: null,
      federal_history_verified: false,
      usaspending_summary: null,
      federal_grant_history: null,
      service_area: [],
      rucc_codes: null,
      location_city: null,
      location_county: null,
      location_state: null,
    } as unknown as Partial<Client>);
    const raw = mkRaw({
      factor_scores: {
        seat_role: { rating: "strong", rationale: "r" },
        eligibility: { rating: "strong", rationale: "r" },
        geographic: { rating: "strong", rationale: "r" },
        program_history: { rating: "strong", rationale: "r" },
        cost_share: { rating: "strong", rationale: "r" },
        mission: { rating: "strong", rationale: "r" },
      },
    });
    const res = finalizeAlignMatch(raw, blankClient, mkGrant());
    // The three DATA-DEPENDENT factors are forced honest when the client record is blank.
    expect(res.factor_scores.cost_share.rating).toBe("insufficient_data");
    expect(res.factor_scores.program_history.rating).toBe("insufficient_data");
    expect(res.factor_scores.geographic.rating).toBe("insufficient_data");
    // Non-data-dependent factors are left exactly as the model rated them.
    expect(res.factor_scores.seat_role.rating).toBe("strong");
    expect(res.factor_scores.mission.rating).toBe("strong");
  });

  it("the factor-data floor does NOT override a rating when the client HAS the data", () => {
    const richClient = mkClient({
      annual_budget: "$1,200,000",
      match_cost_share_capacity: "10% cash on hand",
      federal_history_verified: true,
      service_area: ["AR -- Statewide"],
      location_state: "AR",
    } as unknown as Partial<Client>);
    const raw = mkRaw({
      factor_scores: {
        seat_role: { rating: "strong", rationale: "r" },
        eligibility: { rating: "strong", rationale: "r" },
        geographic: { rating: "moderate", rationale: "r" },
        program_history: { rating: "moderate", rationale: "r" },
        cost_share: { rating: "strong", rationale: "r" },
        mission: { rating: "strong", rationale: "r" },
      },
    });
    const res = finalizeAlignMatch(raw, richClient, mkGrant());
    expect(res.factor_scores.cost_share.rating).toBe("strong");
    expect(res.factor_scores.program_history.rating).toBe("moderate");
    expect(res.factor_scores.geographic.rating).toBe("moderate");
  });
});
