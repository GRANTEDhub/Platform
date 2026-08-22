import { describe, it, expect } from "vitest";
import {
  prospectEligibilityDrop,
  classifyOrgType,
  grantGeoRestriction,
  normalizeState,
  type EligibilityCandidate,
} from "./prospect-eligibility";
import type { EntityType } from "./entity-types";

// Deterministic tests for the prospect eligibility backstop. Fixtures are SHAPED like the real
// carded prospects the diagnosis pulled (Great Peninsula = WA org, blank location, on a Lake-Superior
// MI/WI grant; Legal Aid of Arkansas = eligible AR nonprofit; a county on a nonprofit-only grant).
// The gate is a pure function, so these prove the plumbing directly; the flag-OFF path is identity
// because discover.ts only calls this when PROSPECT_ELIGIBILITY_GATE_ENABLED is on.

const grant = (geo: string | null) => ({ geographic_eligibility: geo });
const cand = (over: Partial<EligibilityCandidate> = {}): EligibilityCandidate => ({
  name: "Test Org",
  org_type: null,
  location_state: null,
  operates_in_arkansas: false,
  ...over,
});
const NONPROFIT: EntityType[] = ["nonprofit"];

describe("grantGeoRestriction — conservative: a Set only on a clear specific-state restriction", () => {
  it("names specific states -> restriction Set", () => {
    expect(grantGeoRestriction("Lake Superior Basin of Michigan and Wisconsin")).toEqual(new Set(["MI", "WI"]));
    expect(grantGeoRestriction("Arkansas only")).toEqual(new Set(["AR"]));
  });
  it("national / unrestricted / blank -> null (fails open, no drop)", () => {
    for (const g of ["United States", "Nationwide competitive program", "All states and territories", "", null, "No geographic restriction"]) {
      expect(grantGeoRestriction(g), String(g)).toBeNull();
    }
  });
});

describe("normalizeState", () => {
  it("codes, names, blanks", () => {
    expect(normalizeState("AR")).toBe("AR");
    expect(normalizeState("Arkansas")).toBe("AR");
    expect(normalizeState("washington")).toBe("WA");
    expect(normalizeState(null)).toBeNull();
    expect(normalizeState("Zzz")).toBeNull();
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
});

describe("prospectEligibilityDrop — GEO", () => {
  it("Great Peninsula shape: blank location, non-AR, on a MI/WI-restricted grant -> DROP", () => {
    const r = prospectEligibilityDrop(
      cand({ name: "Great Peninsula Conservancy", org_type: null, location_state: null, operates_in_arkansas: false }),
      grant("Lake Superior Basin of Michigan and Wisconsin"),
      NONPROFIT,
      /* isAwardee */ true, // even as an awardee, geo is not trusted on a geo-locked grant
    );
    expect(r).toMatch(/^geo:/);
  });
  it("known out-of-region state -> DROP", () => {
    expect(prospectEligibilityDrop(cand({ location_state: "WA" }), grant("Michigan and Wisconsin"), [], false)).toMatch(/^geo:/);
  });
  it("known AR org on a grant that excludes AR -> DROP", () => {
    expect(prospectEligibilityDrop(cand({ operates_in_arkansas: true, location_state: "AR" }), grant("Michigan and Wisconsin"), [], false)).toMatch(/^geo:/);
  });
  it("in-region org -> keep", () => {
    expect(prospectEligibilityDrop(cand({ location_state: "MI" }), grant("Michigan and Wisconsin"), [], false)).toBeNull();
  });
  it("national grant -> geo never drops, even with unknown region", () => {
    expect(prospectEligibilityDrop(cand({ location_state: null }), grant("United States"), [], false)).toBeNull();
  });
});

describe("prospectEligibilityDrop — ENTITY (with the awardee carve-out)", () => {
  it("wrong coarse type on a nonprofit-only grant, NOT an awardee -> DROP", () => {
    const r = prospectEligibilityDrop(cand({ org_type: "County Government" }), grant("United States"), NONPROFIT, false);
    expect(r).toMatch(/^entity:/);
  });
  it("AWARDEE with a wrong coarse type -> KEEP (entity trusted by construction)", () => {
    // The carve-out: an awardee won this program, so we do not second-guess its entity eligibility.
    expect(prospectEligibilityDrop(cand({ org_type: "County Government" }), grant("United States"), NONPROFIT, true)).toBeNull();
  });
  it("matching coarse type -> keep", () => {
    expect(prospectEligibilityDrop(cand({ org_type: "501(c)(3) nonprofit" }), grant("United States"), NONPROFIT, false)).toBeNull();
  });
  it("empty target-type set -> entity fails open (no drop)", () => {
    expect(prospectEligibilityDrop(cand({ org_type: "County Government" }), grant("United States"), [], false)).toBeNull();
  });
});

describe("prospectEligibilityDrop — the false-negative guard + the documented KNOWN LIMIT", () => {
  it("Legal-Aid-of-Arkansas shape: eligible AR nonprofit on a national grant -> KEEP", () => {
    expect(
      prospectEligibilityDrop(
        cand({ name: "Legal Aid of Arkansas", org_type: "Nonprofit / Legal Aid Organization", location_state: "AR", operates_in_arkansas: true }),
        grant("United States"),
        NONPROFIT,
        false,
      ),
    ).toBeNull();
  });
  it("CJI shape: state-affiliated institute on a states/local/tribal grant -> KEEP", () => {
    expect(
      prospectEligibilityDrop(
        cand({ name: "Criminal Justice Institute", org_type: "State government-affiliated institute", location_state: "AR", operates_in_arkansas: true }),
        grant("United States"),
        ["state_government", "county", "city", "tribal"],
        false,
      ),
    ).toBeNull();
  });
  it("KNOWN LIMIT: null org_type on a nationally-eligible grant is NOT caught (below the gate's resolution)", () => {
    // This is the "Diversity Center of Oklahoma on a faith-based Houses-of-Worship grant" case: org_type
    // is null (nothing structural to check), the grant is nationally eligible (no geo restriction), and
    // "faith-based vs generic nonprofit" is finer than the coarse entity types. The scorer already flags
    // it "inferred -- confirm"; the human review flag covers it. Asserted to PASS, on purpose.
    expect(
      prospectEligibilityDrop(
        cand({ name: "Diversity Center of Oklahoma Inc", org_type: null, location_state: null, operates_in_arkansas: false }),
        grant("United States"),
        NONPROFIT,
        true,
      ),
    ).toBeNull();
  });
});
