import { describe, it, expect, afterEach } from "vitest";
import {
  switcherEnabled,
  clientDashboardId,
  isClientDashboardPath,
  isFullGrantbotPage,
  switcherVisible,
  rosterUrl,
  pickRosterClients,
  type RosterRow,
} from "./switcher";

// Deterministic — no model, no network. Locks the Switcher's gates:
//   ① GRANTBOT_SWITCHER_ENABLED, default off, only the literal "true" (byte-identical OFF).
//   ② clientDashboardId: the /clients/<id> the Switcher defaults its target to (and the launcher
//      mounts on) — sub-routes and the new/invite forms are NOT dashboards.
//   ③ isFullGrantbotPage: hide on the firm OR a client full-chat page (each owns its own surface).
//   ④ switcherVisible: S2 shows on every internal page except a full GrantBot page (contractors get
//      it too now — the picker, not visibility, gates Firm to admins).

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

describe("clientDashboardId", () => {
  it("returns the id for exactly /clients/<id> (optional trailing slash)", () => {
    expect(clientDashboardId("/clients/abc123")).toBe("abc123");
    expect(clientDashboardId("/clients/abc123/")).toBe("abc123");
  });

  it("is null for sub-routes, the forms, the list, and non-client paths", () => {
    expect(clientDashboardId("/clients/abc123/grantbot")).toBeNull();
    expect(clientDashboardId("/clients/abc123/roadmap")).toBeNull();
    expect(clientDashboardId("/clients/new")).toBeNull();
    expect(clientDashboardId("/clients/invite")).toBeNull();
    expect(clientDashboardId("/clients")).toBeNull();
    expect(clientDashboardId("/grants")).toBeNull();
    expect(clientDashboardId("/clientships/123")).toBeNull();
    expect(clientDashboardId(null)).toBeNull();
    expect(clientDashboardId("")).toBeNull();
  });

  it("isClientDashboardPath mirrors clientDashboardId", () => {
    expect(isClientDashboardPath("/clients/abc123")).toBe(true);
    expect(isClientDashboardPath("/clients/abc123/roadmap")).toBe(false);
    expect(isClientDashboardPath("/clients/new")).toBe(false);
  });
});

describe("isFullGrantbotPage", () => {
  it("is true for the firm full page and a client full-chat page", () => {
    expect(isFullGrantbotPage("/grantbot")).toBe(true);
    expect(isFullGrantbotPage("/grantbot/anything")).toBe(true);
    expect(isFullGrantbotPage("/clients/abc123/grantbot")).toBe(true);
    expect(isFullGrantbotPage("/clients/abc123/grantbot/x")).toBe(true);
  });

  it("is false for a client dashboard, sub-routes, and other pages", () => {
    expect(isFullGrantbotPage("/clients/abc123")).toBe(false);
    expect(isFullGrantbotPage("/clients/abc123/roadmap")).toBe(false);
    expect(isFullGrantbotPage("/grants")).toBe(false);
    expect(isFullGrantbotPage(null)).toBe(false);
  });
});

describe("switcherVisible", () => {
  it("shows on every internal page — dashboards, sub-routes, forms, the list", () => {
    expect(switcherVisible("/grants")).toBe(true);
    expect(switcherVisible("/clients")).toBe(true);
    expect(switcherVisible("/clients/abc123")).toBe(true); // S2: owns the dashboard now
    expect(switcherVisible("/clients/abc123/roadmap")).toBe(true);
    expect(switcherVisible("/clients/new")).toBe(true);
    expect(switcherVisible("/")).toBe(true);
  });

  it("hides on a full GrantBot page (firm or client)", () => {
    expect(switcherVisible("/grantbot")).toBe(false);
    expect(switcherVisible("/clients/abc123/grantbot")).toBe(false);
  });
});

describe("rosterUrl", () => {
  it("is the plain roster off a dashboard, and adds ?include=<id> on one", () => {
    expect(rosterUrl(null)).toBe("/api/grantbot/roster");
    expect(rosterUrl(undefined)).toBe("/api/grantbot/roster");
    expect(rosterUrl("abc123")).toBe("/api/grantbot/roster?include=abc123");
  });

  it("URL-encodes the include id", () => {
    expect(rosterUrl("a b/c")).toBe("/api/grantbot/roster?include=a%20b%2Fc");
  });
});

describe("pickRosterClients", () => {
  const rows: RosterRow[] = [
    { id: "a", name: "Acme", pipeline_stage: "active" },
    { id: "b", name: "Beacon", pipeline_stage: null },
    { id: "c", name: "Closed Co", pipeline_stage: "archived" },
    { id: "d", name: "Dropped", pipeline_stage: "rejected" },
    { id: "e", name: "", pipeline_stage: "active" }, // empty name — invalid
    { id: null, name: "No Id", pipeline_stage: "active" }, // no id — invalid
  ];

  it("keeps valid rows and drops archived/rejected and malformed ones", () => {
    expect(pickRosterClients(rows)).toEqual([
      { id: "a", name: "Acme" },
      { id: "b", name: "Beacon" },
    ]);
  });

  it("re-admits ONLY the included id even when it is archived/rejected", () => {
    expect(pickRosterClients(rows, "c")).toEqual([
      { id: "a", name: "Acme" },
      { id: "b", name: "Beacon" },
      { id: "c", name: "Closed Co" },
    ]);
    // a different archived client (d) stays dropped — include re-admits exactly one id
    expect(pickRosterClients(rows, "c").some((r) => r.id === "d")).toBe(false);
  });

  it("never fabricates a client the RLS read didn't return (include an absent id)", () => {
    expect(pickRosterClients(rows, "zzz").map((r) => r.id)).toEqual(["a", "b"]);
  });

  it("does not duplicate an included id that already passes the filter", () => {
    expect(pickRosterClients(rows, "a")).toEqual([
      { id: "a", name: "Acme" },
      { id: "b", name: "Beacon" },
    ]);
  });
});
