import { describe, it, expect } from "vitest";
import { allocationSourcesFor, ALLOCATION_SOURCES } from "./allocation-sources";

describe("allocationSourcesFor", () => {
  it("returns the seeded JAG source for CFDA 16.738", () => {
    const out = allocationSourcesFor([{ number: "16.738" }]);
    expect(out).toHaveLength(1);
    expect(out[0].label).toMatch(/JAG/i);
    expect(out[0].urls.length).toBeGreaterThan(0);
    // Every seeded URL is https .gov (the fetch allowlist enforces .gov anyway; this keeps the
    // data honest at the source).
    for (const u of out[0].urls) expect(u).toMatch(/^https:\/\/[^/]+\.gov(\/|$)/);
  });

  it("strips a trailing letter suffix on the CFDA (16.738A → 16.738)", () => {
    expect(allocationSourcesFor([{ number: "16.738A" }])).toHaveLength(1);
    expect(allocationSourcesFor([{ number: " 16.738 " }])).toHaveLength(1);
  });

  it("returns empty for an unseeded CFDA (the common case)", () => {
    expect(allocationSourcesFor([{ number: "93.243" }])).toEqual([]);
  });

  it("fails open on null / empty / malformed input", () => {
    expect(allocationSourcesFor(null)).toEqual([]);
    expect(allocationSourcesFor(undefined)).toEqual([]);
    expect(allocationSourcesFor([])).toEqual([]);
    expect(allocationSourcesFor([{ number: null }, { number: "" }, {}])).toEqual([]);
  });

  it("de-duplicates when a grant lists the same CFDA twice", () => {
    expect(allocationSourcesFor([{ number: "16.738" }, { number: "16.738A" }])).toHaveLength(1);
  });

  // STATE-vs-LOCAL split (Byrne-JAG 16.738): a state_government (SAA) client is the DIRECT recipient and
  // must read the STATE allocations / SAA pages, not the local disparate-jurisdiction table (the wrong
  // evidence that made QA over-demote a genuine direct state recipient, 2026-09-03).
  it("16.738: a state_government client gets the STATE pages, not the local table", () => {
    const local = allocationSourcesFor([{ number: "16.738" }], "local_government");
    const state = allocationSourcesFor([{ number: "16.738" }], "state_government");
    // The state variant is a DIFFERENT URL set — and specifically NOT the local disparate-jurisdiction PDF.
    expect(state[0].urls).not.toEqual(local[0].urls);
    expect(state[0].urls.some((u) => /local-allocations/i.test(u))).toBe(false);
    expect(state[0].urls.some((u) => /jag\/allocations|state-administering-agencies/i.test(u))).toBe(true);
    expect(state[0].label).toMatch(/state administering agency|direct recipient/i);
  });

  it("16.738: local / nonprofit / higher_ed / omitted org_type all get the default local table", () => {
    const expected = allocationSourcesFor([{ number: "16.738" }]); // omitted → default
    for (const org of ["local_government", "nonprofit", "higher_education", "small_business", null, undefined]) {
      expect(allocationSourcesFor([{ number: "16.738" }], org as string | null)).toEqual(expected);
    }
    // The default is the LOCAL disparate-jurisdiction table (unchanged — case 1 JAG-county still grounds).
    expect(expected[0].urls.some((u) => /local-allocations/i.test(u))).toBe(true);
  });

  it("a non-state-split program (16.575) ignores org_type — same sources for state and local", () => {
    const state = allocationSourcesFor([{ number: "16.575" }], "state_government");
    const local = allocationSourcesFor([{ number: "16.575" }], "local_government");
    expect(state).toEqual(local);
  });

  it("every seeded entry is well-formed (.gov urls, non-empty label) — including any stateUrls", () => {
    for (const [cfda, src] of Object.entries(ALLOCATION_SOURCES)) {
      expect(cfda, "CFDA key shape").toMatch(/^\d{2}\.\d{3}$/);
      expect(src.label.trim().length, cfda).toBeGreaterThan(0);
      expect(src.urls.length, cfda).toBeGreaterThan(0);
      for (const u of src.urls) expect(u, cfda).toMatch(/^https:\/\/[^/]+\.gov(\/|$)/);
      // A stateUrls variant, when present, is held to the same .gov + non-empty-label bar.
      if (src.stateUrls) {
        expect(src.stateUrls.length, `${cfda} stateUrls`).toBeGreaterThan(0);
        expect((src.stateLabel ?? src.label).trim().length, `${cfda} stateLabel`).toBeGreaterThan(0);
        for (const u of src.stateUrls) expect(u, `${cfda} stateUrls`).toMatch(/^https:\/\/[^/]+\.gov(\/|$)/);
      }
    }
  });
});
