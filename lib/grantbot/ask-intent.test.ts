import { describe, it, expect, afterEach, vi } from "vitest";
import {
  grantbotAskFromReviewEnabled,
  askStarters,
  stashAskDraft,
  askOpenHref,
} from "./ask-intent";
import { draftKey } from "./wire";

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

  it("names BOTH the client and the grant in every question (so GrantBot has the scope)", () => {
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

describe("stashAskDraft — writes the exact composer-stash shape GrantBotChat reads", () => {
  const realWindow = (globalThis as { window?: unknown }).window;
  afterEach(() => {
    if (realWindow === undefined) delete (globalThis as { window?: unknown }).window;
    else (globalThis as { window?: unknown }).window = realWindow;
  });

  function fakeWindow() {
    const store = new Map<string, string>();
    const sessionStorage = {
      setItem: vi.fn((k: string, v: string) => store.set(k, v)),
      getItem: (k: string) => store.get(k) ?? null,
      removeItem: (k: string) => store.delete(k),
    };
    (globalThis as { window?: unknown }).window = { sessionStorage };
    return { store, sessionStorage };
  }

  it("writes draft set, everything else empty/null, under the shared draftKey", () => {
    const { store } = fakeWindow();
    stashAskDraft("c1", "Who wins this?");
    const raw = store.get(draftKey("c1"));
    expect(raw).toBeTruthy();
    expect(JSON.parse(raw!)).toEqual({
      draft: "Who wins this?",
      pasted: "",
      pasteLabel: "",
      attachedFile: null,
      attachedImage: null,
    });
  });

  it("does NOT clobber an existing non-empty draft (preserves the staffer's unsent work)", () => {
    const { store } = fakeWindow();
    const typed = JSON.stringify({ draft: "half-typed question the staffer left", pasted: "", pasteLabel: "", attachedFile: null, attachedImage: null });
    store.set(draftKey("c1"), typed);
    stashAskDraft("c1", "Who wins this?");
    // Unchanged — the seed was skipped so the in-progress work survives.
    expect(store.get(draftKey("c1"))).toBe(typed);
  });

  it("does NOT clobber an existing pasted email / attachment even with an empty draft field", () => {
    const { store } = fakeWindow();
    const pasted = JSON.stringify({ draft: "", pasted: "a long pasted email thread", pasteLabel: "email.txt", attachedFile: null, attachedImage: null });
    store.set(draftKey("c1"), pasted);
    stashAskDraft("c1", "Deadline realistic?");
    expect(store.get(draftKey("c1"))).toBe(pasted);
  });

  it("DOES seed when the existing stash is empty content or malformed", () => {
    const { store } = fakeWindow();
    // Empty draft → no unsent work → seed writes.
    store.set(draftKey("c1"), JSON.stringify({ draft: "", pasted: "", pasteLabel: "", attachedFile: null, attachedImage: null }));
    stashAskDraft("c1", "Eligible?");
    expect(JSON.parse(store.get(draftKey("c1"))!).draft).toBe("Eligible?");
    // Malformed → treated as no work → seed writes.
    store.set(draftKey("c2"), "not json {");
    stashAskDraft("c2", "Who wins this?");
    expect(JSON.parse(store.get(draftKey("c2"))!).draft).toBe("Who wins this?");
  });

  it("is a harmless no-op when sessionStorage throws (private mode)", () => {
    (globalThis as { window?: unknown }).window = {
      sessionStorage: {
        setItem: () => {
          throw new Error("QuotaExceeded");
        },
      },
    };
    expect(() => stashAskDraft("c1", "x")).not.toThrow();
  });

  it("is a no-op with no window (SSR)", () => {
    delete (globalThis as { window?: unknown }).window;
    expect(() => stashAskDraft("c1", "x")).not.toThrow();
  });
});

describe("askOpenHref — the existing open-the-corner-blank deep-link", () => {
  it("targets the client dashboard with ?grantbot=new (honoured by launcher and Switcher)", () => {
    expect(askOpenHref("abc-123")).toBe("/clients/abc-123?grantbot=new");
  });
});
