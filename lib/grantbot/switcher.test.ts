import { describe, it, expect, afterEach } from "vitest";
import { switcherEnabled, isClientRecordPath, firmSwitcherVisible } from "./switcher";

// Deterministic — no model, no network. Locks the Switcher's two gates:
//   ① GRANTBOT_SWITCHER_ENABLED, default off, only the literal "true" (byte-identical OFF).
//   ② the visibility rule: the firm Switcher shows for admins everywhere EXCEPT a client record
//      page, where the per-client launcher owns the corner (so no double bubble).

describe("switcherEnabled", () => {
  const prev = process.env.GRANTBOT_SWITCHER_ENABLED;
  afterEach(() => {
    if (prev === undefined) delete process.env.GRANTBOT_SWITCHER_ENABLED;
    else process.env.GRANTBOT_SWITCHER_ENABLED = prev;
  });

  it("is off by default and off for anything but the literal 'true'", () => {
    delete process.env.GRANTBOT_SWITCHER_ENABLED;
    expect(switcherEnabled()).toBe(false);
    for (const v of ["1", "TRUE", "yes", "false", ""]) {
      process.env.GRANTBOT_SWITCHER_ENABLED = v;
      expect(switcherEnabled()).toBe(false);
    }
    process.env.GRANTBOT_SWITCHER_ENABLED = "true";
    expect(switcherEnabled()).toBe(true);
  });
});

describe("isClientRecordPath", () => {
  it("is true for a client record page and anything under it", () => {
    expect(isClientRecordPath("/clients/abc123")).toBe(true);
    expect(isClientRecordPath("/clients/abc123/grantbot")).toBe(true);
    expect(isClientRecordPath("/clients/abc123/roadmap/xyz")).toBe(true);
  });

  it("is false for the portfolio LIST and non-client paths (the firm Switcher shows there)", () => {
    expect(isClientRecordPath("/clients")).toBe(false);
    expect(isClientRecordPath("/clients/")).toBe(false);
    expect(isClientRecordPath("/grants")).toBe(false);
    expect(isClientRecordPath("/grantbot")).toBe(false);
    expect(isClientRecordPath("/leads/123")).toBe(false);
    expect(isClientRecordPath("/")).toBe(false);
  });

  it("is false for null/undefined/empty (never throws on a missing pathname)", () => {
    expect(isClientRecordPath(null)).toBe(false);
    expect(isClientRecordPath(undefined)).toBe(false);
    expect(isClientRecordPath("")).toBe(false);
  });

  it("does not match a path that merely starts with the word clients", () => {
    // A sibling route like /clientships must not read as a client record.
    expect(isClientRecordPath("/clientships/123")).toBe(false);
  });
});

describe("firmSwitcherVisible", () => {
  it("shows for an admin off a client record page", () => {
    expect(firmSwitcherVisible("/grants", true)).toBe(true);
    expect(firmSwitcherVisible("/clients", true)).toBe(true); // the LIST, not a record
    expect(firmSwitcherVisible("/", true)).toBe(true);
  });

  it("hides for an admin ON a client record page (the launcher owns that corner)", () => {
    expect(firmSwitcherVisible("/clients/abc123", true)).toBe(false);
    expect(firmSwitcherVisible("/clients/abc123/grantbot", true)).toBe(false);
  });

  it("hides for a non-admin everywhere (firm is admin-only in S1)", () => {
    expect(firmSwitcherVisible("/grants", false)).toBe(false);
    expect(firmSwitcherVisible("/clients", false)).toBe(false);
    expect(firmSwitcherVisible("/clients/abc123", false)).toBe(false);
  });
});
