import { describe, it, expect, afterEach } from "vitest";
import { lowAwardSkipReason } from "./award-count-gate";
import type { ExtractedGrant } from "./engine";
import type { Client } from "@/types/database";

// Deterministic unit test — no model call. Covers the flag kill-switch, the <10 threshold and
// its boundary, the state-gov / IHE carve-out, and (most important) the fail-open behavior on
// every missing input: a null/empty/non-numeric award count and a null/unknown org_type must
// NEVER skip. Green here fully covers the gate (it is pure JS); no eval is needed to flip the flag.

const FLAG = "MATCH_LOW_AWARD_GATE_ENABLED";

const mkGrant = (num_awards: string | null): ExtractedGrant =>
  ({ num_awards } as unknown as ExtractedGrant);
const mkClient = (org_type: string | null): Client =>
  ({ org_type } as unknown as Client);

afterEach(() => {
  delete process.env[FLAG];
});
const enable = () => {
  process.env[FLAG] = "true";
};

describe("lowAwardSkipReason", () => {
  it("OFF is identity: never skips, even a 5-award county", () => {
    expect(lowAwardSkipReason(mkGrant("5"), mkClient("local_government"))).toBeNull();
  });

  describe("flag ON", () => {
    it("skips a <10-award grant for a county (local_government)", () => {
      enable();
      expect(lowAwardSkipReason(mkGrant("5"), mkClient("local_government"))).toMatch(
        /low award count/i,
      );
    });

    it("skips for nonprofit and small_business too", () => {
      enable();
      expect(lowAwardSkipReason(mkGrant("5"), mkClient("nonprofit"))).not.toBeNull();
      expect(lowAwardSkipReason(mkGrant("5"), mkClient("small_business"))).not.toBeNull();
    });

    it("SURFACES for the carve-out: state_government and higher_education", () => {
      enable();
      expect(lowAwardSkipReason(mkGrant("5"), mkClient("state_government"))).toBeNull();
      expect(lowAwardSkipReason(mkGrant("5"), mkClient("higher_education"))).toBeNull();
    });

    it("threshold is 'fewer than 10': 9 skips, 10 surfaces", () => {
      enable();
      expect(lowAwardSkipReason(mkGrant("9"), mkClient("local_government"))).not.toBeNull();
      expect(lowAwardSkipReason(mkGrant("10"), mkClient("local_government"))).toBeNull();
    });

    it("fails open on a missing / non-numeric award count (never skip on unknown count)", () => {
      enable();
      expect(lowAwardSkipReason(mkGrant(null), mkClient("local_government"))).toBeNull();
      expect(lowAwardSkipReason(mkGrant(""), mkClient("local_government"))).toBeNull();
      expect(lowAwardSkipReason(mkGrant("Unknown"), mkClient("local_government"))).toBeNull();
    });

    it("fails open on a null / legacy-unrecognized org_type (never skip on missing client data)", () => {
      enable();
      expect(lowAwardSkipReason(mkGrant("5"), mkClient(null))).toBeNull();
      expect(lowAwardSkipReason(mkGrant("5"), mkClient("tribal_government"))).toBeNull();
    });
  });
});
