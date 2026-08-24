import { describe, it, expect } from "vitest";
import {
  prospectEligibilityDrop,
  classifyOrgType,
  circularLocationInference,
  type EligibilityCandidate,
  type MatchSignals,
} from "./prospect-eligibility";
import type { EntityType } from "./entity-types";

// Deterministic tests for the reworked prospect eligibility backstop. The geo axis is now
// CIRCULAR-INFERENCE detection over the scorer's own match.inferred_fields (not a field re-parse), and
// the entity axis exempts a genuinely sub-routed prospect (#414). The gate is a pure function, so these
// prove the plumbing directly; the flag-OFF path is identity because discover.ts only calls this when
// PROSPECT_ELIGIBILITY_GATE_ENABLED is on. Geo fixtures are the three REAL diagnosed rows: Great
// Peninsula (WA conservancy, location back-filled from the program -> drop), Western NY Land Conservancy
// and Diversity Center of Oklahoma (location grounded in the org's OWN name -> keep).

const cand = (over: Partial<EligibilityCandidate> = {}): EligibilityCandidate => ({
  name: "Test Org",
  org_type: null,
  ...over,
});
const mkMatch = (over: Partial<MatchSignals> = {}): MatchSignals => ({
  inferred_fields: [],
  seat_ref: "P0",
  proposed_role: "Prime",
  ...over,
});
const NONPROFIT: EntityType[] = ["nonprofit"];

// The three real inferred_fields, phrased as the scorer emits them.
const GREAT_PENINSULA_FIELDS = [
  "Location / service area inferred as the Upper Great Lakes region based on the program name and prior awards under this program.",
];
const WESTERN_NY_FIELDS = ["Service area inferred from the organization's name (Western New York Land Conservancy)."];
const DIVERSITY_CENTER_FIELDS = ["Location inferred as Oklahoma based on the organization name 'Diversity Center of Oklahoma'."];

describe("circularLocationInference — drop when location is grounded in the GRANT, keep when in the ORG's name", () => {
  it("Great Peninsula: location back-filled from the program / prior awards -> CIRCULAR (true)", () => {
    expect(circularLocationInference(GREAT_PENINSULA_FIELDS)).toBe(true);
  });
  it("Western NY / Diversity Center: location grounded in the org's OWN name -> NOT circular (false)", () => {
    expect(circularLocationInference(WESTERN_NY_FIELDS)).toBe(false);
    expect(circularLocationInference(DIVERSITY_CENTER_FIELDS)).toBe(false);
  });
  it("other grant-grounded phrasings -> circular", () => {
    for (const f of [
      "Service area inferred as the eligible region of the grant.",
      "Location assumed to be in-region based on prior awards under this program.",
      "Operates in the program's target geography (inferred, no independent signal).",
    ]) {
      expect(circularLocationInference([f]), f).toBe(true);
    }
  });
  it("no location inference, or a non-geographic inference -> keep (false)", () => {
    expect(circularLocationInference(null)).toBe(false);
    expect(circularLocationInference([])).toBe(false);
    expect(circularLocationInference(["Annual budget inferred from staff size."])).toBe(false); // not a location field
    expect(circularLocationInference(["Org type inferred as nonprofit from the 501(c)(3) status."])).toBe(false);
  });
  it("AMBIGUOUS (grant AND org-name basis both present) -> keep (fails open, conservative)", () => {
    expect(
      circularLocationInference([
        "Location inferred from the program name, though the organization name also suggests the region.",
      ]),
    ).toBe(false);
  });
});

describe("classifyOrgType — coarse, fails open (null) when unclassifiable", () => {
  it("classifies the common shapes", () => {
    expect(classifyOrgType("County Government")).toBe("county");
    expect(classifyOrgType("State government-affiliated institute")).toBe("state_government");
    expect(classifyOrgType("501(c)(3) nonprofit")).toBe("nonprofit");
    expect(classifyOrgType("Faith-based institution (Catholic church)")).toBe("nonprofit");
    expect(classifyOrgType("Local Workforce Development Board")).toBe("special_district");
    expect(classifyOrgType("Accredited institution of higher education")).toBe("higher_education");
  });
  it("null / empty / unknown -> null (no classification -> entity check fails open)", () => {
    expect(classifyOrgType(null)).toBeNull();
    expect(classifyOrgType("")).toBeNull();
    expect(classifyOrgType("some vague thing")).toBeNull();
  });
  it("does NOT substring-misclassify a nonprofit via unanchored branches (transitional/hospitality/tribute)", () => {
    expect(classifyOrgType("Nonprofit providing transitional housing services")).toBe("nonprofit");
    expect(classifyOrgType("Hospitality-focused nonprofit foundation")).toBe("nonprofit");
    expect(classifyOrgType("Tribute Foundation (a 501(c)(3) nonprofit)")).toBe("nonprofit");
    expect(classifyOrgType("Regional public transit authority")).toBe("transit_agency");
    expect(classifyOrgType("Community hospital")).toBe("hospital");
    expect(classifyOrgType("Cherokee Tribal Government")).toBe("tribal");
  });
});

describe("prospectEligibilityDrop — GEO (circular inference)", () => {
  it("Great Peninsula shape: circular location inference -> DROP", () => {
    const r = prospectEligibilityDrop(
      cand({ name: "Great Peninsula Conservancy", org_type: null }),
      NONPROFIT,
      /* isAwardee */ true, // geo is not trusted even for an awardee
      mkMatch({ inferred_fields: GREAT_PENINSULA_FIELDS, seat_ref: "NONE", proposed_role: "Not Recommended" }),
    );
    expect(r).toMatch(/^geo:/);
  });
  it("Western NY / Diversity Center shape: org-name-grounded location -> KEEP", () => {
    expect(
      prospectEligibilityDrop(cand({ name: "Western New York Land Conservancy" }), NONPROFIT, false, mkMatch({ inferred_fields: WESTERN_NY_FIELDS })),
    ).toBeNull();
    expect(
      prospectEligibilityDrop(cand({ name: "Diversity Center of Oklahoma Inc" }), NONPROFIT, true, mkMatch({ inferred_fields: DIVERSITY_CENTER_FIELDS })),
    ).toBeNull();
  });
  it("no location inference -> geo never drops", () => {
    expect(prospectEligibilityDrop(cand(), NONPROFIT, false, mkMatch({ inferred_fields: [] }))).toBeNull();
  });
});

describe("prospectEligibilityDrop — ENTITY (awardee carve-out + the #414 sub-routed exemption)", () => {
  it("wrong coarse type on a nonprofit-only grant, NOT an awardee, prime-seated -> DROP", () => {
    const r = prospectEligibilityDrop(cand({ org_type: "County Government" }), NONPROFIT, false, mkMatch());
    expect(r).toMatch(/^entity:/);
  });
  it("AWARDEE with a wrong coarse type -> KEEP (entity trusted by construction)", () => {
    expect(prospectEligibilityDrop(cand({ org_type: "County Government" }), NONPROFIT, true, mkMatch())).toBeNull();
  });
  it("#414 — a SUB-ROUTED prospect (supporting seat) is NOT dropped against prime-only types", () => {
    // The coupling: discovery scores through matchGrantToClient, which sub-routes. A prospect routed to
    // a supporting seat is eligible AS A SUB; measuring it against the PRIME types would wrongly drop it.
    const bySeat = prospectEligibilityDrop(
      cand({ org_type: "Community-based reentry nonprofit" }),
      ["county", "state_government"], // gov-only PRIME types
      false,
      mkMatch({ seat_ref: "S0_7", proposed_role: "Sub" }),
    );
    expect(bySeat).toBeNull();
    // Role-based detection too (defensive: either signal exempts).
    const byRole = prospectEligibilityDrop(
      cand({ org_type: "County Government" }),
      NONPROFIT,
      false,
      mkMatch({ seat_ref: "NONE", proposed_role: "Co-Applicant" }),
    );
    expect(byRole).toBeNull();
  });
  it("a PRIME-seated prospect with a matching type -> keep; empty target set -> keep", () => {
    expect(prospectEligibilityDrop(cand({ org_type: "501(c)(3) nonprofit" }), NONPROFIT, false, mkMatch())).toBeNull();
    expect(prospectEligibilityDrop(cand({ org_type: "County Government" }), [], false, mkMatch())).toBeNull();
  });
});

describe("prospectEligibilityDrop — false-negative guard + the documented KNOWN LIMIT", () => {
  it("Legal-Aid-of-Arkansas shape: eligible AR nonprofit, no circular geo -> KEEP", () => {
    expect(
      prospectEligibilityDrop(
        cand({ name: "Legal Aid of Arkansas", org_type: "Nonprofit / Legal Aid Organization" }),
        NONPROFIT,
        false,
        mkMatch({ inferred_fields: [] }),
      ),
    ).toBeNull();
  });
  it("KNOWN LIMIT: null org_type + no location inference on a nationally-eligible grant is NOT caught", () => {
    // The "Diversity Center on a faith-based Houses-of-Worship grant" case: nothing structural to check
    // and no circular location inference. Below the gate's resolution; the scorer's "inferred — confirm"
    // human flag covers it. Asserted to PASS, on purpose.
    expect(
      prospectEligibilityDrop(
        cand({ name: "Diversity Center of Oklahoma Inc", org_type: null }),
        NONPROFIT,
        true,
        mkMatch({ inferred_fields: DIVERSITY_CENTER_FIELDS }),
      ),
    ).toBeNull();
  });
});
