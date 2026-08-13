import { describe, it, expect } from "vitest";
import { normalizeForMatch, sectionHits, MIN_QUOTE_CHARS, MAX_QUOTE_CHARS } from "./nofo-text";

// Behaviour lock for the shared raw-NOFO-text prep extracted from allowable-uses.ts and
// requirements.ts. Both quote gates verify a model quote by folding it and the raw_text through
// normalizeForMatch and testing exact containment; these tests pin the fold and the section scan so
// the shared copy cannot silently drift from the two byte-identical originals it replaced.

describe("normalizeForMatch", () => {
  it("removes soft hyphen, zero-width chars, BOM and word joiner", () => {
    // U+00AD soft hyphen, U+200B ZWSP, U+200C ZWNJ, U+200D ZWJ, U+FEFF BOM, U+2060 word joiner.
    const s = "co­oper​at‌io‍n﻿ x⁠y";
    expect(normalizeForMatch(s)).toBe("cooperation xy");
  });

  it("joins hyphenation across a line break", () => {
    expect(normalizeForMatch("appropri-\nate")).toBe("appropriate");
    expect(normalizeForMatch("multi-\r\n  word")).toBe("multiword");
  });

  it("folds curly quotes and primes to ASCII", () => {
    expect(normalizeForMatch("‘a’ “b” ′ ″")).toBe("'a' \"b\" ' \"");
  });

  it("folds the dash family to an ASCII hyphen", () => {
    // figure, en, em, horizontal bar, minus, non-breaking hyphen -> "-"
    expect(normalizeForMatch("a‒b–c—d―e−f‑g")).toBe("a-b-c-d-e-f-g");
  });

  it("folds an ellipsis to three dots", () => {
    expect(normalizeForMatch("wait… done")).toBe("wait... done");
  });

  it("collapses every whitespace run (including NBSP and newlines) to one space and trims", () => {
    expect(normalizeForMatch("  a   b\t\n c  ")).toBe("a b c");
  });

  it("does NOT case-fold", () => {
    expect(normalizeForMatch("SHALL NOT")).toBe("SHALL NOT");
    expect(normalizeForMatch("Shall")).not.toBe(normalizeForMatch("shall"));
  });

  it("makes an artifact-bearing quote match the raw source (the actual gate behaviour)", () => {
    // A model copies a span faithfully, but the raw_text carries extraction artifacts (curly quote,
    // en-dash range, hyphenation break). Folding both sides makes containment succeed.
    const raw = 'The award ranges “$5,000–$50,000” for eligi-\nble applicants.';
    const quote = 'The award ranges "$5,000-$50,000" for eligible applicants.';
    expect(normalizeForMatch(raw).includes(normalizeForMatch(quote))).toBe(true);
  });
});

describe("sectionHits", () => {
  const patterns = [/allowable\s+costs?/gi, /funding\s+restrictions?/gi];

  it("returns every occurrence, sorted by index", () => {
    const raw = "intro funding restrictions ... then allowable cost ... and Allowable Costs again";
    const hits = sectionHits(raw, patterns);
    expect(hits.length).toBe(3);
    expect([...hits]).toEqual([...hits].sort((a, b) => a - b));
    for (const h of hits) expect(h).toBeGreaterThanOrEqual(0);
  });

  it("excludes a contents-page line (dot leader before a page number)", () => {
    const toc = "IV. Allowable Costs .......... 41\n";
    const body = "\nAllowable Costs\nThe funds may be used for staff.";
    const hits = sectionHits(toc + body, patterns);
    // Only the real body heading survives -- the TOC line is dropped.
    expect(hits.length).toBe(1);
    expect(hits[0]).toBeGreaterThan(toc.length - 1);
  });

  it("excludes a column-aligned contents line (two+ spaces before a page number)", () => {
    const raw = "Allowable Costs      7\nlater the real Allowable Costs section begins here";
    const hits = sectionHits(raw, patterns);
    expect(hits.length).toBe(1);
  });

  it("resets lastIndex per call so a reused global regex does not skip the head", () => {
    const raw = "allowable cost at the very start";
    // Same pattern array, run twice: a stale lastIndex from run 1 would miss the head on run 2.
    expect(sectionHits(raw, patterns)).toEqual(sectionHits(raw, patterns));
    expect(sectionHits(raw, patterns).length).toBe(1);
  });

  it("returns no hits when nothing matches", () => {
    expect(sectionHits("nothing relevant here", patterns)).toEqual([]);
  });
});

describe("quote bounds", () => {
  it("are the shared 24/300 window", () => {
    expect(MIN_QUOTE_CHARS).toBe(24);
    expect(MAX_QUOTE_CHARS).toBe(300);
  });
});
