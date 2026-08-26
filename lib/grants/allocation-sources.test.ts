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

  it("every seeded entry is well-formed (.gov urls, non-empty label)", () => {
    for (const [cfda, src] of Object.entries(ALLOCATION_SOURCES)) {
      expect(cfda, "CFDA key shape").toMatch(/^\d{2}\.\d{3}$/);
      expect(src.label.trim().length, cfda).toBeGreaterThan(0);
      expect(src.urls.length, cfda).toBeGreaterThan(0);
      for (const u of src.urls) expect(u, cfda).toMatch(/^https:\/\/[^/]+\.gov(\/|$)/);
    }
  });
});
