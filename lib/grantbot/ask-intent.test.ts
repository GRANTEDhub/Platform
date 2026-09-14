import { describe, it, expect, afterEach } from "vitest";
import {
  grantbotAskFromReviewEnabled,
  askStarters,
  stashAskContext,
  takeAskContext,
  askOpenHref,
} from "./ask-intent";
import { askContextKey } from "./wire";

describe("grantbotAskFromReviewEnabled — off unless exactly 'true'", () => {
  const prev = process.env.GRANTBOT_ASK_FROM_REVIEW_ENABLED;
  afterEach(() => {
    if (prev === undefined) delete process.env.GRANTBOT_ASK_FROM_REVIEW_ENABLED;
    else process.env.GRANTBOT_ASK_FROM_REVIEW_ENABLED = prev;
  });
  it("is false when unset (byte-identical-off default)", () => {
    delete process.env.GRANTBOT_ASK_FROM_REVIEW_ENABLED;
    expect(grantbotAskFromReviewEnabled()).toBe(false);
  });
  it("is false for any value other than 'true'", () => {
    for (const v of ["1", "TRUE", "yes", "false", ""]) {
      process.env.GRANTBOT_ASK_FROM_REVIEW_ENABLED = v;
      expect(grantbotAskFromReviewEnabled()).toBe(false);
    }
  });
  it("is true only for exactly 'true'", () => {
    process.env.GRANTBOT_ASK_FROM_REVIEW_ENABLED = "true";
    expect(grantbotAskFromReviewEnabled()).toBe(true);
  });
});

describe("askStarters — three grant-scoped questions that name client + grant", () => {
  const starters = askStarters("Mississippi County", "the Arkansas Unpaved Roads Program (AURP)");

  it("returns exactly three distinct starters covering who-wins / eligibility / deadline", () => {
    expect(starters).toHaveLength(3);
    expect(starters.map((s) => s.key)).toEqual(["who_wins", "eligibility", "deadline"]);
    expect(new Set(starters.map((s) => s.chip)).size).toBe(3);
    expect(new Set(starters.map((s) => s.question)).size).toBe(3);
  });

  it("names BOTH the client and the grant in every question (robust even if grounding is weak)", () => {
    for (const s of starters) {
      expect(s.question).toContain("Mississippi County");
      expect(s.question).toContain("the Arkansas Unpaved Roads Program (AURP)");
    }
  });

  it("keeps the grant-advisory framing GRANTED cares about", () => {
    const byKey = Object.fromEntries(starters.map((s) => [s.key, s.question]));
    // prime-vs-sub is a hard org rule — the eligibility starter must draw the distinction.
    expect(byKey.eligibility).toMatch(/prime/i);
    expect(byKey.eligibility).toMatch(/partner\/sub|sub/i);
    // deadline reality includes registration + level of effort, not just the date.
    expect(byKey.deadline).toMatch(/SAM|registration/i);
    expect(byKey.deadline).toMatch(/level of effort|effort/i);
  });

  it("falls back gracefully when client or grant is blank", () => {
    const s = askStarters("  ", "");
    expect(s[0].question).toContain("this client");
    expect(s[0].question).toContain("this grant");
  });
});

describe("stashAskContext / takeAskContext — the grant anchor round-trip", () => {
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

  it("stashes the anchor under its OWN key (not the draft key) and reads it back", () => {
    const { store } = fakeWindow();
    stashAskContext("c1", { grantId: "g-1", grantTitle: "AURP" });
    expect(JSON.parse(store.get(askContextKey("c1"))!)).toEqual({ grantId: "g-1", grantTitle: "AURP" });
    expect(takeAskContext("c1")).toEqual({ grantId: "g-1", grantTitle: "AURP" });
  });

  it("take is READ-AND-CLEAR (a second read is null, so it never re-anchors a later thread)", () => {
    const { store } = fakeWindow();
    stashAskContext("c1", { grantId: "g-1", grantTitle: "AURP" });
    expect(takeAskContext("c1")).not.toBeNull();
    expect(store.get(askContextKey("c1"))).toBeUndefined();
    expect(takeAskContext("c1")).toBeNull();
  });

  it("is per-client keyed (a different client's anchor is not consumed)", () => {
    fakeWindow();
    stashAskContext("c1", { grantId: "g-1", grantTitle: "AURP" });
    expect(takeAskContext("c2")).toBeNull();
    expect(takeAskContext("c1")).toEqual({ grantId: "g-1", grantTitle: "AURP" });
  });

  it("last write wins (clicking a second grant replaces the pending anchor)", () => {
    fakeWindow();
    stashAskContext("c1", { grantId: "g-1", grantTitle: "First" });
    stashAskContext("c1", { grantId: "g-2", grantTitle: "Second" });
    expect(takeAskContext("c1")).toEqual({ grantId: "g-2", grantTitle: "Second" });
  });

  it("returns null on a malformed or grant-id-less anchor (a corrupt entry → a general thread, no crash)", () => {
    const { store } = fakeWindow();
    store.set(askContextKey("c1"), "not json {");
    expect(takeAskContext("c1")).toBeNull();
    store.set(askContextKey("c2"), JSON.stringify({ grantTitle: "no id" }));
    expect(takeAskContext("c2")).toBeNull();
  });

  it("tolerates a missing title (empty string) — askStarters handles the blank", () => {
    fakeWindow();
    stashAskContext("c1", { grantId: "g-1", grantTitle: "" });
    expect(takeAskContext("c1")).toEqual({ grantId: "g-1", grantTitle: "" });
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
    expect(() => stashAskContext("c1", { grantId: "g", grantTitle: "t" })).not.toThrow();
    expect(takeAskContext("c1")).toBeNull();
    delete (globalThis as { window?: unknown }).window;
    expect(() => stashAskContext("c1", { grantId: "g", grantTitle: "t" })).not.toThrow();
    expect(takeAskContext("c1")).toBeNull();
  });
});

describe("askOpenHref — the existing open-the-corner-blank deep-link", () => {
  it("targets the client dashboard with ?grantbot=new (honoured by launcher and Switcher)", () => {
    expect(askOpenHref("abc-123")).toBe("/clients/abc-123?grantbot=new");
  });
});
