import { describe, it, expect } from "vitest";
import { AR_STATE_SEED, SEED_BATCH, needsHeadless } from "./fixture";

describe("AR state seed fixture", () => {
  it("is the reviewed set of 40 AR / state / auto programs", () => {
    expect(AR_STATE_SEED).toHaveLength(40);
    for (const e of AR_STATE_SEED) {
      expect(e.jurisdiction).toBe("AR");
      expect(e.funder_type).toBe("state");
      expect(e.monitor_mode).toBe("auto");
      expect(e.grantor.trim()).not.toBe("");
      expect(e.program.trim()).not.toBe("");
    }
  });

  it("every url is a valid https URL", () => {
    for (const e of AR_STATE_SEED) {
      expect(e.url).toMatch(/^https:\/\//);
      expect(() => new URL(e.url)).not.toThrow();
    }
  });

  it("program names are globally unique (each is a distinct grant)", () => {
    const names = AR_STATE_SEED.map((e) => e.program);
    expect(new Set(names).size).toBe(names.length);
  });

  it("shared-page / re-pointed programs carry seed_text so the shred can disambiguate them", () => {
    for (const e of AR_STATE_SEED) {
      if (e.tags?.includes("shared_page") || e.tags?.includes("repointed")) {
        expect(e.seed_text, `${e.program} needs seed_text`).toBeTruthy();
      }
    }
    // The shared aac-grants page carries 3 distinct Arts Council programs, each with its own seed_text.
    const shared = AR_STATE_SEED.filter((e) => e.url.endsWith("/aac-grants"));
    expect(shared).toHaveLength(3);
    expect(new Set(shared.map((e) => e.seed_text)).size).toBe(3);
  });

  it("needsHeadless is true for exactly the AEDC + DFA entries, and matches the 'headless' tag", () => {
    const headlessByDomain = AR_STATE_SEED.filter((e) => needsHeadless(e.url));
    const headlessByTag = AR_STATE_SEED.filter((e) => e.tags?.includes("headless"));
    expect(headlessByDomain.map((e) => e.program).sort()).toEqual(headlessByTag.map((e) => e.program).sort());
    // 6 AEDC + 1 DFA = 7
    expect(headlessByDomain).toHaveLength(7);
    for (const e of headlessByDomain) {
      expect(new URL(e.url).hostname).toMatch(/(arkansasedc\.com|dfa\.arkansas\.gov)$/);
    }
  });

  it("needsHeadless is false for a plain agency page and robust to bad input", () => {
    expect(needsHeadless("https://ardot.gov/divisions/")).toBe(false);
    expect(needsHeadless("https://agriculture.arkansas.gov/x")).toBe(false);
    expect(needsHeadless("not a url")).toBe(false);
    // suffix match, not substring — a lookalike host must not trip it
    expect(needsHeadless("https://arkansasedc.com.evil.test/x")).toBe(false);
    expect(needsHeadless("https://www.arkansasedc.com/x")).toBe(true);
  });

  it("has a stable seed_batch stamp", () => {
    expect(SEED_BATCH).toBe("ar_master_sheet_2026");
  });
});
