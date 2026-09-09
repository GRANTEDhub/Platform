import { describe, it, expect } from "vitest";
import { forwardedStatusLabel, referralTrackingEnabled } from "./referral";

// Deterministic — no model, no network. Locks the referral-tracking flag reader + the forwarded status
// label (text-only, colour-blind-safe; blank recipient tolerated).

describe("referralTrackingEnabled", () => {
  it("is true ONLY for the exact string 'true' (default OFF / byte-identical dark)", () => {
    const prev = process.env.REFERRAL_TRACKING_ENABLED;
    try {
      delete process.env.REFERRAL_TRACKING_ENABLED;
      expect(referralTrackingEnabled()).toBe(false);
      process.env.REFERRAL_TRACKING_ENABLED = "false";
      expect(referralTrackingEnabled()).toBe(false);
      process.env.REFERRAL_TRACKING_ENABLED = "1";
      expect(referralTrackingEnabled()).toBe(false);
      process.env.REFERRAL_TRACKING_ENABLED = "true";
      expect(referralTrackingEnabled()).toBe(true);
    } finally {
      if (prev === undefined) delete process.env.REFERRAL_TRACKING_ENABLED;
      else process.env.REFERRAL_TRACKING_ENABLED = prev;
    }
  });
});

describe("forwardedStatusLabel", () => {
  it("names the recipient on each surface", () => {
    expect(forwardedStatusLabel("Jane", "list")).toBe("Forwarded to Jane · awaiting response");
    expect(forwardedStatusLabel("Jane", "staff")).toBe("Client forwarded internally to Jane — awaiting response");
    expect(forwardedStatusLabel("Jane", "portal")).toBe("Forwarded internally to Jane — awaiting response");
  });

  it("tolerates a blank / missing recipient (a forward with no name is still a valid forward)", () => {
    expect(forwardedStatusLabel(null, "list")).toBe("Forwarded internally · awaiting response");
    expect(forwardedStatusLabel("   ", "staff")).toBe("Client forwarded this internally — awaiting response");
    expect(forwardedStatusLabel(undefined, "portal")).toBe("Forwarded internally — awaiting response");
  });

  it("trims the recipient (a padded note never renders its whitespace)", () => {
    expect(forwardedStatusLabel("  Jane Doe  ", "list")).toBe("Forwarded to Jane Doe · awaiting response");
  });
});
