import { describe, it, expect, afterEach } from "vitest";
import { switcherEnabled, isClientDashboardPath, isFirmFullPagePath, firmSwitcherVisible } from "./switcher";

// Deterministic — no model, no network. Locks the Switcher's two gates:
//   ① GRANTBOT_SWITCHER_ENABLED, default off, only the literal "true" (byte-identical OFF).
//   ② the visibility rule: the firm Switcher shows for admins everywhere EXCEPT the client dashboard
//      route (where the per-client launcher owns the corner — so no double bubble) and the firm full
//      page /grantbot (already the full firm chat). It must SHOW on client SUB-routes and the
//      new/invite forms, which mount no launcher (Codex #544).

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

describe("isClientDashboardPath", () => {
  it("is true for exactly the client dashboard route (where the launcher mounts)", () => {
    expect(isClientDashboardPath("/clients/abc123")).toBe(true);
    expect(isClientDashboardPath("/clients/abc123/")).toBe(true); // trailing slash
  });

  it("is FALSE for a client's sub-routes — no launcher there, so the Switcher shows", () => {
    expect(isClientDashboardPath("/clients/abc123/grantbot")).toBe(false);
    expect(isClientDashboardPath("/clients/abc123/roadmap")).toBe(false);
    expect(isClientDashboardPath("/clients/abc123/roadmap/xyz")).toBe(false);
    expect(isClientDashboardPath("/clients/abc123/edit")).toBe(false);
  });

  it("is FALSE for the /clients/new and /clients/invite forms (real routes, no launcher)", () => {
    expect(isClientDashboardPath("/clients/new")).toBe(false);
    expect(isClientDashboardPath("/clients/invite")).toBe(false);
  });

  it("is false for the portfolio LIST and non-client paths", () => {
    expect(isClientDashboardPath("/clients")).toBe(false);
    expect(isClientDashboardPath("/clients/")).toBe(false);
    expect(isClientDashboardPath("/grants")).toBe(false);
    expect(isClientDashboardPath("/")).toBe(false);
  });

  it("is false for null/undefined/empty and a lookalike route", () => {
    expect(isClientDashboardPath(null)).toBe(false);
    expect(isClientDashboardPath(undefined)).toBe(false);
    expect(isClientDashboardPath("")).toBe(false);
    // A sibling route like /clientships must not read as a client dashboard.
    expect(isClientDashboardPath("/clientships/123")).toBe(false);
  });
});

describe("isFirmFullPagePath", () => {
  it("is true for /grantbot and any subpath, false elsewhere", () => {
    expect(isFirmFullPagePath("/grantbot")).toBe(true);
    expect(isFirmFullPagePath("/grantbot/anything")).toBe(true);
    expect(isFirmFullPagePath("/grants")).toBe(false);
    expect(isFirmFullPagePath("/clients/abc123/grantbot")).toBe(false); // the client's grantbot, not the firm one
    expect(isFirmFullPagePath(null)).toBe(false);
  });
});

describe("firmSwitcherVisible", () => {
  it("shows for an admin off the dashboard/firm-page — INCLUDING client sub-routes and the forms", () => {
    expect(firmSwitcherVisible("/grants", true)).toBe(true);
    expect(firmSwitcherVisible("/clients", true)).toBe(true); // the LIST, not a dashboard
    expect(firmSwitcherVisible("/", true)).toBe(true);
    expect(firmSwitcherVisible("/clients/abc123/roadmap", true)).toBe(true); // sub-route, no launcher
    expect(firmSwitcherVisible("/clients/abc123/grantbot", true)).toBe(true);
    expect(firmSwitcherVisible("/clients/new", true)).toBe(true);
    expect(firmSwitcherVisible("/clients/invite", true)).toBe(true);
  });

  it("hides for an admin ON the client dashboard (the launcher owns that corner)", () => {
    expect(firmSwitcherVisible("/clients/abc123", true)).toBe(false);
  });

  it("hides for an admin on the firm full page /grantbot (redundant there)", () => {
    expect(firmSwitcherVisible("/grantbot", true)).toBe(false);
  });

  it("hides for a non-admin everywhere (firm is admin-only in S1)", () => {
    expect(firmSwitcherVisible("/grants", false)).toBe(false);
    expect(firmSwitcherVisible("/clients", false)).toBe(false);
    expect(firmSwitcherVisible("/clients/abc123/roadmap", false)).toBe(false);
  });
});
