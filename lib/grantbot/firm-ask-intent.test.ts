import { describe, it, expect, afterEach } from "vitest";
import {
  grantbotAskFromProspectingEnabled,
  firmAskStarters,
  stashFirmAskContext,
  takeFirmAskContext,
} from "./firm-ask-intent";
import { firmAskContextKey } from "./wire";

describe("grantbotAskFromProspectingEnabled — off unless exactly 'true'", () => {
  const prev = process.env.GRANTBOT_ASK_FROM_PROSPECTING_ENABLED;
  afterEach(() => {
    if (prev === undefined) delete process.env.GRANTBOT_ASK_FROM_PROSPECTING_ENABLED;
    else process.env.GRANTBOT_ASK_FROM_PROSPECTING_ENABLED = prev;
  });
  it("is false when unset (byte-identical-off default)", () => {
    delete process.env.GRANTBOT_ASK_FROM_PROSPECTING_ENABLED;
    expect(grantbotAskFromProspectingEnabled()).toBe(false);
  });
  it("is false for any value other than 'true'", () => {
    for (const v of ["1", "TRUE", "yes", "false", ""]) {
      process.env.GRANTBOT_ASK_FROM_PROSPECTING_ENABLED = v;
      expect(grantbotAskFromProspectingEnabled()).toBe(false);
    }
  });
  it("is true only for exactly 'true'", () => {
    process.env.GRANTBOT_ASK_FROM_PROSPECTING_ENABLED = "true";
    expect(grantbotAskFromProspectingEnabled()).toBe(true);
  });
});

describe("firmAskStarters — three prospecting-scoped questions that name the grant", () => {
  const starters = firmAskStarters("the Recreational Trails Program (RTP)");

  it("returns exactly three distinct starters, why-these-prospects first", () => {
    expect(starters).toHaveLength(3);
    expect(starters.map((s) => s.key)).toEqual(["why_these", "who_wins", "eligibility"]);
    expect(new Set(starters.map((s) => s.chip)).size).toBe(3);
    expect(new Set(starters.map((s) => s.question)).size).toBe(3);
  });

  it("names the grant in every question", () => {
    for (const s of starters) expect(s.question).toContain("Recreational Trails Program");
  });

  it("falls back to 'this grant' on a blank title (never a dangling name)", () => {
    for (const s of firmAskStarters("")) expect(s.question).toContain("this grant");
  });
});

describe("stashFirmAskContext / takeFirmAskContext — the firm grant anchor round-trip", () => {
  const realWindow = (globalThis as { window?: unknown }).window;
  afterEach(() => {
    if (realWindow === undefined) delete (globalThis as { window?: unknown }).window;
    else (globalThis as { window?: unknown }).window = realWindow;
  });

  function fakeWindow() {
    const store = new Map<string, string>();
    const sessionStorage = {
      setItem: (k: string, v: string) => store.set(k, v),
      getItem: (k: string) => store.get(k) ?? null,
      removeItem: (k: string) => store.delete(k),
    };
    (globalThis as { window?: unknown }).window = { sessionStorage };
    return { store, sessionStorage };
  }

  it("stashes under the FIRM key (a single fixed key, no client id) and reads it back", () => {
    const { store } = fakeWindow();
    stashFirmAskContext({ grantId: "g-1", grantTitle: "RTP" });
    expect(JSON.parse(store.get(firmAskContextKey)!)).toEqual({ grantId: "g-1", grantTitle: "RTP" });
    expect(takeFirmAskContext()).toEqual({ grantId: "g-1", grantTitle: "RTP" });
  });

  it("take is READ-AND-CLEAR (a second read is null, so it never re-anchors a later thread)", () => {
    const { store } = fakeWindow();
    stashFirmAskContext({ grantId: "g-1", grantTitle: "RTP" });
    expect(takeFirmAskContext()).not.toBeNull();
    expect(store.get(firmAskContextKey)).toBeUndefined();
    expect(takeFirmAskContext()).toBeNull();
  });

  it("last write wins (clicking a second grant replaces the pending anchor)", () => {
    fakeWindow();
    stashFirmAskContext({ grantId: "g-1", grantTitle: "First" });
    stashFirmAskContext({ grantId: "g-2", grantTitle: "Second" });
    expect(takeFirmAskContext()).toEqual({ grantId: "g-2", grantTitle: "Second" });
  });

  it("returns null on a malformed or grant-id-less anchor (a corrupt entry → a general thread, no crash)", () => {
    const { store } = fakeWindow();
    store.set(firmAskContextKey, "not json {");
    expect(takeFirmAskContext()).toBeNull();
    store.set(firmAskContextKey, JSON.stringify({ grantTitle: "no id" }));
    expect(takeFirmAskContext()).toBeNull();
  });

  it("is a harmless no-op when sessionStorage throws (private mode) and with no window (SSR)", () => {
    (globalThis as { window?: unknown }).window = {
      sessionStorage: {
        setItem: () => {
          throw new Error("QuotaExceeded");
        },
        getItem: () => {
          throw new Error("blocked");
        },
        removeItem: () => {},
      },
    };
    expect(() => stashFirmAskContext({ grantId: "g", grantTitle: "t" })).not.toThrow();
    expect(takeFirmAskContext()).toBeNull();
    delete (globalThis as { window?: unknown }).window;
    expect(() => stashFirmAskContext({ grantId: "g", grantTitle: "t" })).not.toThrow();
    expect(takeFirmAskContext()).toBeNull();
  });
});
