import { describe, it, expect, afterEach } from "vitest";
import {
  switcherEnabled,
  clientDashboardId,
  isClientDashboardPath,
  isFullGrantbotPage,
  switcherVisible,
  rosterUrl,
  pickRosterClients,
  mergeRecentThreads,
  deepLinkNeedsRemount,
  dispatchOpenGrantBot,
  GRANTBOT_OPEN_EVENT,
  type RosterRow,
  type RecentThread,
} from "./switcher";

// Deterministic — no model, no network. Locks the Switcher's gates:
//   ① GRANTBOT_SWITCHER_ENABLED, default off, only the literal "true" (byte-identical OFF).
//   ② clientDashboardId: the /clients/<id> the Switcher defaults its target to (and the launcher
//      mounts on) — sub-routes and the new/invite forms are NOT dashboards.
//   ③ isFullGrantbotPage: hide on the firm OR a client full-chat page (each owns its own surface).
//   ④ switcherVisible: S2 shows on every internal page except a full GrantBot page (contractors get
//      it too now — the picker, not visibility, gates Firm to admins).
//   ⑤ deepLinkNeedsRemount: force a corner-body remount ONLY for a deep-link onto the already-open
//      client, so the Ask-GrantBot seed / Collapse-to-corner is consumed instead of opening blank.

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

describe("mergeRecentThreads", () => {
  const firm: RecentThread[] = [
    { id: "f1", scope: "firm", clientId: null, clientName: null, title: "Firm A", lastMessageAt: "2026-09-13T10:00:00Z" },
    { id: "f2", scope: "firm", clientId: null, clientName: null, title: "Firm B", lastMessageAt: "2026-09-13T08:00:00Z" },
  ];
  const client: RecentThread[] = [
    { id: "c1", scope: "client", clientId: "x", clientName: "Acme", title: "Acme A", lastMessageAt: "2026-09-13T09:00:00Z" },
    { id: "c2", scope: "client", clientId: "y", clientName: "Beacon", title: "Beacon A", lastMessageAt: "2026-09-13T11:00:00Z" },
  ];

  it("interleaves firm + client by lastMessageAt, most recent first", () => {
    expect(mergeRecentThreads(firm, client, 10).map((t) => t.id)).toEqual(["c2", "f1", "c1", "f2"]);
  });

  it("caps to the limit", () => {
    expect(mergeRecentThreads(firm, client, 2).map((t) => t.id)).toEqual(["c2", "f1"]);
    expect(mergeRecentThreads(firm, client, 0)).toEqual([]);
  });

  it("handles empty inputs and sorts an empty/missing timestamp last", () => {
    expect(mergeRecentThreads([], [], 5)).toEqual([]);
    const withBlank: RecentThread[] = [
      { id: "n", scope: "client", clientId: "z", clientName: "NoTime", title: null, lastMessageAt: "" },
    ];
    expect(mergeRecentThreads(firm, withBlank, 10).map((t) => t.id)).toEqual(["f1", "f2", "n"]);
  });
});

describe("deepLinkNeedsRemount", () => {
  it("forces a remount ONLY for a deep-link onto the already-open client", () => {
    // The bug case: a "?grantbot=" deep-link (Ask-GrantBot seed / Collapse-to-corner) whose target is
    // the client the corner already shows keeps the id key unchanged, so without a bump the seed opens
    // blank. This is the only case that must force the remount.
    expect(deepLinkNeedsRemount(true, true)).toBe(true);
  });

  it("does NOT remount when the deep-link switches to a different client (id key already changes)", () => {
    expect(deepLinkNeedsRemount(true, false)).toBe(false);
  });

  it("does NOT remount on a plain navigation with no deep-link (nothing to open; avoids a spinner + refetch)", () => {
    expect(deepLinkNeedsRemount(false, true)).toBe(false);
    expect(deepLinkNeedsRemount(false, false)).toBe(false);
  });
});

// The in-place open seam: the "Ask GrantBot" button dispatches this window event and the mounted Switcher
// opens the corner without navigating (the dashboard-bounce fix). Locks the event name + detail shape so
// the button and the listener can't drift, and the SSR no-op (a corner never opens server-side anyway).
describe("dispatchOpenGrantBot", () => {
  const realWindow = (globalThis as { window?: unknown }).window;
  afterEach(() => {
    if (realWindow === undefined) delete (globalThis as { window?: unknown }).window;
    else (globalThis as { window?: unknown }).window = realWindow;
  });

  it("dispatches GRANTBOT_OPEN_EVENT carrying the clientId in detail", () => {
    const bus = new EventTarget();
    (globalThis as { window?: unknown }).window = bus;
    let detail: unknown = null;
    bus.addEventListener(GRANTBOT_OPEN_EVENT, (e) => {
      detail = (e as CustomEvent).detail;
    });
    dispatchOpenGrantBot("client-1");
    expect(detail).toEqual({ clientId: "client-1" });
  });

  it("is a harmless no-op when there is no window (SSR)", () => {
    delete (globalThis as { window?: unknown }).window;
    expect(() => dispatchOpenGrantBot("client-1")).not.toThrow();
  });
});
