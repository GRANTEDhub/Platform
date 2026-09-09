import { describe, it, expect } from "vitest";
import { awardRangeOrEstimate, formatAwardRange, compactTerm, parseAwardCount } from "./format";

// Deterministic — no model, no network. Locks the two PR-A grant-report fixes:
//   ① Award range never renders a bare blank when the size is deducible (pool ÷ awards, labeled "est.").
//   ② Term is compacted to fit the facts tile (units abbreviated, soft word-boundary truncation).

describe("parseAwardCount", () => {
  it("accepts a bare simple count / range", () => {
    expect(parseAwardCount("20")).toBe(20);
    expect(parseAwardCount("Approximately 20")).toBe(20);
    expect(parseAwardCount("up to 20")).toBe(20);
    expect(parseAwardCount("1,200")).toBe(1200);
    // A range yields its LOWER count → the larger, never-understated per-award figure.
    expect(parseAwardCount("20–25")).toBe(20);
  });
  it("anchors on the count word when other numbers precede it (Codex #486)", () => {
    // The naive first-integer parser divided by 2026 / 2 here — materially wrong.
    expect(parseAwardCount("FY 2026: 20 awards")).toBe(20);
    expect(parseAwardCount("2 rounds of 10 awards")).toBe(10);
    expect(parseAwardCount("Approximately 15 grants")).toBe(15);
  });
  it("rejects ambiguous / non-count text (falls through → no estimate, never a wrong divisor)", () => {
    expect(parseAwardCount(null)).toBeNull();
    expect(parseAwardCount("")).toBeNull();
    expect(parseAwardCount("several")).toBeNull();
    expect(parseAwardCount("0")).toBeNull(); // zero is not a divisor
    // Multiple numbers with no count word to anchor on → too ambiguous to divide by.
    expect(parseAwardCount("2 rounds in 2026")).toBeNull();
    expect(parseAwardCount("20 (estimated), see NOFO")).toBeNull();
  });
});

describe("awardRangeOrEstimate", () => {
  it("returns the REAL range when it is present (never deduces over stated data)", () => {
    expect(awardRangeOrEstimate("$100,000", "$500,000", "$10,000,000", "20")).toBe("$100K – $500K");
    // One-sided real range is still real.
    expect(awardRangeOrEstimate(null, "$500,000", "$10,000,000", "20")).toBe("$500K");
  });

  it("DEDUCES pool÷awards as a labeled estimate when the real range is empty (the IUSE case)", () => {
    // $10M ÷ 20 ≈ $500K, labeled est. — never a bare blank when the size is knowable.
    expect(awardRangeOrEstimate(null, null, "$10,000,000", "20")).toBe("~$500K est.");
    expect(awardRangeOrEstimate("", "", "$10,000,000", "Approximately 20")).toBe("~$500K est.");
  });

  it("falls through to — only when NEITHER a real range NOR a deducible pool÷awards exists", () => {
    expect(awardRangeOrEstimate(null, null, null, "20")).toBe("—"); // no pool
    expect(awardRangeOrEstimate(null, null, "$10,000,000", null)).toBe("—"); // no count
    expect(awardRangeOrEstimate(null, null, "Varies", "20")).toBe("—"); // pool not numeric
    expect(awardRangeOrEstimate(null, null, "$10,000,000", "0")).toBe("—"); // count zero
  });

  it("DEDUCES the estimate for a STORED-ZERO range (Simpler.gov's 0 sentinel), not just a null one", () => {
    // The recurring award-$0 bug: award_range_min/max come back as "0" from the API, which used to render
    // "$0" and slip past the empty-only fallback. Now the zero reads as absent → pool÷awards fires.
    // ICAM: $11.96M ÷ 20 ≈ $598K.
    expect(awardRangeOrEstimate("0", "0", "$11,960,000", "20")).toBe("~$598K est.");
    expect(awardRangeOrEstimate("$0", "$0.00", "$10,000,000", "20")).toBe("~$500K est.");
  });
});

describe("formatAwardRange", () => {
  it("renders a real range / one-sided range", () => {
    expect(formatAwardRange("$100,000", "$500,000")).toBe("$100K – $500K");
    expect(formatAwardRange(null, "$500,000")).toBe("$500K");
    expect(formatAwardRange(null, null)).toBe("—");
  });

  it("drops a <= 0 bound so a stored '0'/'$0' never renders as $0", () => {
    expect(formatAwardRange("0", "0")).toBe("—"); // Simpler.gov's unspecified sentinel → absent, not "$0"
    expect(formatAwardRange("$0", "$500,000")).toBe("$500K"); // bogus floor dropped, real ceiling kept
    expect(formatAwardRange("0.00", null)).toBe("—");
  });

  it("KEEPS a non-numeric range verbatim — never clobbers 'Varies' / 'See NOFO' (regression guard)", () => {
    // parseAmount returns null for these, so the <= 0 drop can't fire — the stated text must survive.
    expect(formatAwardRange("Varies", null)).toBe("Varies");
    expect(formatAwardRange("See NOFO", null)).toBe("See NOFO");
    expect(formatAwardRange("Varies", "Varies")).toBe("Varies – Varies");
  });
});

describe("compactTerm", () => {
  it("abbreviates units + filler so it fits the tile (Shannon's example)", () => {
    expect(compactTerm("Up to 3 years (4 with incentive)")).toBe("Up to 3 yrs (4 w/ incentive)");
    expect(compactTerm("Approximately 36 months")).toBe("~ 36 mos");
  });

  it("soft-truncates a long term at a word boundary with an ellipsis (full text stays on hover)", () => {
    const long = "Up to 3 years, renewable annually subject to satisfactory progress and available appropriations";
    const out = compactTerm(long);
    expect(out.length).toBeLessThanOrEqual(45);
    expect(out.endsWith("…")).toBe(true);
    expect(out).not.toMatch(/\s…$/); // no dangling space before the ellipsis
  });

  it("returns 'Not stated' for empty and leaves a short term intact", () => {
    expect(compactTerm(null)).toBe("Not stated");
    expect(compactTerm("  ")).toBe("Not stated");
    expect(compactTerm("2 yrs")).toBe("2 yrs");
  });
});
