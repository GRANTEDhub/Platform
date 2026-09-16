import { describe, it, expect } from "vitest";
import { awardRangeOrEstimate, formatAwardRange, formatAwardListLabel, compactTerm, parseAwardCount, formatDeadlineCompact, formatDeadlineListLabel, formatAwardStatTile, formatDeadlineStatTile } from "./format";

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

describe("formatDeadlineCompact", () => {
  it("returns null (never throws) for empty / non-date free text", () => {
    for (const v of [null, undefined, "", "   ", "Rolling", "Ongoing", "TBD", "See NOFO"]) {
      expect(formatDeadlineCompact(v)).toBeNull();
    }
  });

  it("returns null (never throws) on a garbled date — the exact crash the AR shred triggered", () => {
    // The old code did `format(parseISO(x))`; parseISO on an invalid date returns an
    // Invalid Date and `format` throws RangeError: Invalid time value, 500-ing the page.
    // The new-Date() path returns null instead.
    expect(formatDeadlineCompact("2026-99-99")).toBeNull();
    expect(() => formatDeadlineCompact("2026-99-99")).not.toThrow();
  });

  it("formats a non-ISO but Date-parseable deadline instead of throwing (parseISO rejected these)", () => {
    // These pass deadlineDaysLeft's lenient new Date() gate, so the compact label MUST
    // format them too rather than throw — the parser mismatch that caused the incident.
    expect(formatDeadlineCompact("9/15/2026")).toMatch(/^[A-Za-z]{3} \d{1,2}$/);
    expect(formatDeadlineCompact("Sep 15, 2026")).toMatch(/^[A-Za-z]{3} \d{1,2}$/);
  });

  it("formats a clean ISO date to a compact 'MMM d' label", () => {
    expect(formatDeadlineCompact("2026-09-15T12:00:00Z")).toMatch(/^[A-Za-z]{3} \d{1,2}$/);
  });

  it("reads a bare YYYY-MM-DD as a LOCAL calendar date — no UTC off-by-one (Codex P1)", () => {
    // Must be the same day in every runner timezone: new Date("2026-09-15") is UTC midnight,
    // which renders as the previous day west of UTC on a client-rendered surface.
    expect(formatDeadlineCompact("2026-09-15")).toBe("Sep 15");
  });
});

describe("formatDeadlineListLabel", () => {
  it("formats a real date (ISO or common formats) as a compact date", () => {
    expect(formatDeadlineListLabel("10/9/2026")).toBe("Oct 9, 2026"); // local parse, deterministic
    expect(formatDeadlineListLabel("2026-10-09")).toMatch(/^[A-Za-z]{3} \d{1,2}, 202\d$/);
  });

  it("keeps a SHORT free-text deadline whole", () => {
    expect(formatDeadlineListLabel("Rolling")).toBe("Rolling");
    expect(formatDeadlineListLabel("Varies")).toBe("Varies");
  });

  it("soft-truncates a verbose free-text deadline so a list cell can't overflow", () => {
    // The AR-shred failure mode: a whole sentence (or an error note) in submission_deadline.
    const para = "February/March Intent to Apply (cycle year TBD): September 30, 2026; Full Application: November 6";
    const out = formatDeadlineListLabel(para);
    expect(out.length).toBeLessThanOrEqual(23); // CAP 22 + the ellipsis
    expect(out.endsWith("…")).toBe(true);
    expect(out).not.toMatch(/\s…$/); // no dangling space before the ellipsis
    expect(out.startsWith("February")).toBe(true);
    expect(formatDeadlineListLabel("Not extracted — full program page not available at source").endsWith("…")).toBe(true);
  });

  it("never dangles a trailing dash (incl. em dash) or splits a surrogate pair", () => {
    // Em dash right at the word-boundary cut must be stripped, not glued to the ellipsis.
    const em = formatDeadlineListLabel("Deadline notice — waitwhatever more text");
    expect(em.endsWith("…")).toBe(true);
    expect(em).not.toMatch(/[—–-]…$/);
    // An astral char straddling the 22-unit cap must not leave a lone surrogate (mojibake).
    const astral = formatDeadlineListLabel("x".repeat(21) + "\u{1F600}" + " more text here");
    expect(astral).not.toContain("�");
    expect(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(astral)).toBe(false);
  });

  it("returns an em dash for empty / missing", () => {
    expect(formatDeadlineListLabel(null)).toBe("—");
    expect(formatDeadlineListLabel("   ")).toBe("—");
  });
});

describe("formatAwardListLabel", () => {
  it("passes a real figure / range through unchanged", () => {
    expect(formatAwardListLabel("$100K – $500K")).toBe("$100K – $500K");
    expect(formatAwardListLabel("$500K")).toBe("$500K");
    expect(formatAwardListLabel("~$598K est.")).toBe("~$598K est.");
    expect(formatAwardListLabel("—")).toBe("—");
  });

  it("keeps SHORT stated-but-unnumeric values (not placeholder junk)", () => {
    // formatAwardRange deliberately keeps "Varies"/"See NOFO" — they say the award is variable / stated
    // elsewhere, unlike the AR-shred "no value" tokens. The list label must not clobber them.
    expect(formatAwardListLabel("Varies")).toBe("Varies");
    expect(formatAwardListLabel("See NOFO")).toBe("See NOFO");
    expect(formatAwardListLabel("Varies – Varies")).toBe("Varies – Varies");
  });

  it("collapses AR-shred placeholder junk to a single 'Not stated'", () => {
    expect(formatAwardListLabel("Not stated – Not stated")).toBe("Not stated");
    expect(formatAwardListLabel("Unknown – Unknown")).toBe("Not stated");
    expect(formatAwardListLabel("Not available – Not available")).toBe("Not stated");
    expect(formatAwardListLabel("N/A")).toBe("Not stated");
    expect(formatAwardListLabel("TBD – TBD")).toBe("Not stated");
  });

  it("soft-truncates a long free-text award so the fixed-width cell can't overflow", () => {
    // The exact AR-state failure mode from Shannon's screenshot: a whole sentence in award_range_*.
    const long = "Maximum per project set at the beginning of each funding cycle -- not specified in the NOFO";
    const out = formatAwardListLabel(long);
    expect(out.length).toBeLessThanOrEqual(23); // CAP 22 + the ellipsis
    expect(out.endsWith("…")).toBe(true);
    expect(out).not.toMatch(/[\s—–-]…$/); // no dangling space/dash before the ellipsis
    // A phrase that merely CONTAINS a placeholder word ("not specified in…") is NOT mislabelled.
    expect(out).not.toBe("Not stated");
  });

  it("returns an em dash for empty / missing", () => {
    expect(formatAwardListLabel(null)).toBe("—");
    expect(formatAwardListLabel("   ")).toBe("—");
  });
});

// The ALERT PDF stat-TILE variants — tighter than the list cell (collapse, not soft-truncate) because the
// tile is a tiny fixed grid fraction with a 26px serif value. Proven end-to-end on the real MS County junk
// values in lib/alerts/data.test.ts; these lock the helper contract directly.
describe("formatAwardStatTile", () => {
  it("keeps a clean $ range / short token", () => {
    expect(formatAwardStatTile("50000", "250000")).toBe("$50K – $250K");
    expect(formatAwardStatTile("Varies", "Varies")).toBe("Varies – Varies");
  });

  it("collapses pure-placeholder junk to 'Not stated'", () => {
    expect(formatAwardStatTile("Not available", "Not available")).toBe("Not stated");
    expect(formatAwardStatTile("Unknown", "Unknown")).toBe("Not stated");
  });

  it("collapses a prose SENTENCE award to 'Not stated' (not an ellipsized fragment)", () => {
    expect(formatAwardStatTile("Not stated", "Maximum per project set at the beginning of each funding cycle")).toBe(
      "Not stated",
    );
  });

  it("returns null (no tile) when there is genuinely no award", () => {
    expect(formatAwardStatTile(null, null)).toBeNull();
    expect(formatAwardStatTile("0", "0")).toBeNull(); // formatAwardRange drops a $0 sentinel → "—"
  });

  it("collapses a long free-text pairing to 'Not stated' — never a FABRICATED figure from a prose number", () => {
    // A >22 combined string (≥1 long prose bound) → "Not stated", so a bare number embedded in prose (a
    // percentage / count / year) can't be surfaced as a dollar award — the mixed-branch regression parseAmount
    // introduced ("Not to exceed 25% …" → a bogus "$25"). Claude Code Review #571.
    expect(formatAwardStatTile("Not to exceed 25% of the total project cost", "varies by the size and scope of the applicant organization")).toBe("Not stated");
    // A real min + a long prose max: safely "Not stated" (hiding a known floor beats inventing one).
    expect(formatAwardStatTile("50000", "Maximum per project set at the beginning of each funding cycle")).toBe("Not stated");
    // A genuinely clean short range is still kept verbatim.
    expect(formatAwardStatTile("50000", "250000")).toBe("$50K – $250K");
  });
});

describe("formatDeadlineStatTile", () => {
  it("formats a real date as month + day (no year)", () => {
    expect(formatDeadlineStatTile("2027-01-15")).toBe("Jan 15");
    expect(formatDeadlineStatTile("10/9/2026")).toBe("Oct 9");
  });

  it("maps the rolling/continuous family to 'Rolling'", () => {
    expect(formatDeadlineStatTile("Applications accepted on a rolling basis")).toBe("Rolling");
    expect(formatDeadlineStatTile("Continuous / open until filled")).toBe("Rolling");
  });

  it("maps empty OR placeholder junk to 'No deadline'", () => {
    expect(formatDeadlineStatTile(null)).toBe("No deadline");
    expect(formatDeadlineStatTile("")).toBe("No deadline");
    expect(formatDeadlineStatTile("Not available - verify at fly.arkansas.gov")).toBe("No deadline");
    expect(formatDeadlineStatTile("Unknown -- funding varies by federal fiscal year appropriation")).toBe("No deadline");
    expect(formatDeadlineStatTile("TBD")).toBe("No deadline");
  });

  it("soft-truncates any OTHER free-text (never a long overflow)", () => {
    const out = formatDeadlineStatTile("Due 30 days after the annual program announcement is posted");
    expect(out.length).toBeLessThanOrEqual(15); // CAP 14 + the ellipsis
    expect(out.endsWith("…")).toBe(true);
  });
});
