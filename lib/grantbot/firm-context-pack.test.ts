import { describe, it, expect } from "vitest";
import {
  buildFirmContextPack,
  buildFirmGaps,
  renderFirmRoster,
  renderFirmGaps,
  FIRM_COLUMNS,
  FIRM_FORBIDDEN_COLUMNS,
  type FirmPackClient,
} from "./firm-context-pack";
import type { ClientProfile } from "@/types/database";

// Deterministic — no model, no network. Locks the Brick 1 firm-roster invariants:
//   ① PROFILES ONLY — the read column list carries nothing commercial/PII/eligibility.
//   ② provenance + staleness are labelled (distilled = machine-derived; NEVER/NO DATE shown).
//   ③ the aggregate gaps state the profiles-only boundary and count real absences.

const baseProfile: ClientProfile = {
  summary: "A regional workforce nonprofit.",
  mission: "Advance rural workforce readiness.",
  core_capabilities: ["job training", "employer partnerships"],
  program_areas: [{ name: "Healthcare training", description: "CNA + phlebotomy" } as never],
  populations_served: ["rural adults", "dislocated workers"],
  geographic_scope: { footprint: "Northwest Arkansas", scale: "regional", states: ["AR"] },
  prime_capacity: { can_prime: true, rationale: "runs its own programs", conditional_on: "match" },
  supporting_roles: ["training provider"],
  partnerships: ["regional employers"],
  funding_priorities: ["workforce", "equipment"],
  fiscal_notes: { annual_budget: "$1.2M" },
  federal_history: { self_reported: "two DOL awards" },
  inferred: [],
  gaps: [],
};

function mk(over: Partial<FirmPackClient> = {}): FirmPackClient {
  return {
    id: "c1",
    name: "Ozark Health Collaborative",
    org_type: "nonprofit",
    status: "active",
    location_city: "Fayetteville",
    location_county: "Washington",
    location_state: "AR",
    service_area: ["Northwest Arkansas"],
    primary_funding_needs: ["workforce"],
    project_stage: "planning",
    annual_budget: "$1.2M",
    match_cost_share_capacity: "up to 20%",
    client_profile: baseProfile,
    client_profile_generated_at: "2026-08-01T00:00:00Z",
    intake_data: { mission: "We train rural healthcare workers.", funding_need: "clinical equipment" },
    profile_confirmed_at: "2026-07-15T00:00:00Z",
    updated_at: "2026-08-20T00:00:00Z",
    ...over,
  };
}

describe("FIRM_COLUMNS — profiles only", () => {
  it("names exactly the profile columns and nothing commercial/PII/eligibility", () => {
    const cols = FIRM_COLUMNS.split(", ");
    // Sanity: the identity + capability + profile columns are present.
    for (const c of ["id", "name", "org_type", "client_profile", "intake_data", "primary_funding_needs"]) {
      expect(cols).toContain(c);
    }
    // The lock: no forbidden column can be in the read list.
    for (const forbidden of FIRM_FORBIDDEN_COLUMNS) {
      expect(cols).not.toContain(forbidden);
    }
  });

  it("never selects *", () => {
    expect(FIRM_COLUMNS).not.toContain("*");
  });
});

describe("buildFirmContextPack", () => {
  it("counts clients and breaks down org types", () => {
    const pack = buildFirmContextPack({
      generatedAt: "2026-09-11T00:00:00Z",
      generatedBy: "shannon@grantedco.com",
      actorRole: "admin",
      clients: [mk(), mk({ id: "c2", name: "Delta Arts Council", org_type: "nonprofit" }), mk({ id: "c3", name: "Benton County", org_type: "local_government" })],
    });
    expect(pack.clientCount).toBe(3);
    expect(pack.orgTypeBreakdown).toEqual({ nonprofit: 2, local_government: 1 });
  });
});

describe("renderFirmRoster — provenance + profiles-only boundary", () => {
  const pack = buildFirmContextPack({
    generatedAt: "2026-09-11T00:00:00Z",
    generatedBy: "shannon@grantedco.com",
    actorRole: "admin",
    clients: [mk()],
  });
  const roster = renderFirmRoster(pack);

  it("names the client and labels its distilled profile as machine-derived", () => {
    expect(roster).toContain("Ozark Health Collaborative");
    expect(roster.toLowerCase()).toContain("machine-derived");
  });

  it("labels the client-stated mission as the org's own words", () => {
    expect(roster).toContain("client's own words");
    expect(roster).toContain("We train rural healthcare workers.");
  });

  it("states the profiles-only boundary in the header (no live grant activity)", () => {
    expect(roster).toContain("NOT IN THIS CONTEXT");
    expect(roster.toLowerCase()).toContain("no scored matches");
  });

  it("renders can_prime THREE-WAY — null is UNKNOWN, never coerced to 'no' (Codex P1)", () => {
    const render = (canPrime: boolean | null) =>
      renderFirmRoster(
        buildFirmContextPack({
          generatedAt: "2026-09-11T00:00:00Z",
          generatedBy: "x",
          actorRole: "admin",
          clients: [mk({ client_profile: { ...baseProfile, prime_capacity: { can_prime: canPrime as boolean, rationale: "r" } } })],
        }),
      );
    expect(render(true)).toContain("can prime: yes");
    expect(render(false)).toContain("can prime: no");
    const unknown = render(null);
    expect(unknown).toContain("can prime: UNKNOWN");
    expect(unknown).not.toContain("can prime: no");
  });

  it("shows NEVER for an unconfirmed profile and NO DATE for an undated distilled profile", () => {
    const p2 = buildFirmContextPack({
      generatedAt: "2026-09-11T00:00:00Z",
      generatedBy: "x",
      actorRole: "admin",
      clients: [mk({ profile_confirmed_at: null, client_profile_generated_at: null })],
    });
    const r2 = renderFirmRoster(p2);
    expect(r2).toContain("NEVER");
    expect(r2).toContain("NO DATE RECORDED");
  });
});

describe("buildFirmGaps — aggregate absences", () => {
  it("always states the profiles-only boundary", () => {
    const gaps = buildFirmGaps(buildFirmContextPack({ generatedAt: "2026-09-11T00:00:00Z", generatedBy: "x", actorRole: "admin", clients: [mk()] }).cards);
    expect(gaps.some((g) => g.includes("PROFILES ONLY"))).toBe(true);
  });

  it("counts clients with no distilled profile", () => {
    const cards = buildFirmContextPack({
      generatedAt: "2026-09-11T00:00:00Z",
      generatedBy: "x",
      actorRole: "admin",
      clients: [mk(), mk({ id: "c2", name: "No Profile Org", client_profile: null })],
    }).cards;
    const gaps = buildFirmGaps(cards);
    expect(gaps.some((g) => /1 of 2 clients have NO distilled profile/.test(g))).toBe(true);
  });

  it("reports an empty roster explicitly", () => {
    expect(buildFirmGaps([])).toEqual(["No active clients are in this roster."]);
  });

  it("renderFirmGaps prints the closed-list header", () => {
    const pack = buildFirmContextPack({ generatedAt: "2026-09-11T00:00:00Z", generatedBy: "x", actorRole: "admin", clients: [mk()] });
    expect(renderFirmGaps(pack)).toContain("WHAT THE PLATFORM DOES NOT KNOW ABOUT THIS ROSTER");
  });
});
