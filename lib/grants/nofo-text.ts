// Shared raw-NOFO-text prep for the quote-grounded enrichers.
//
// EXTRACTED, NOT REWRITTEN. allowable-uses.ts and requirements.ts each carried a byte-identical
// copy of this normalizer plus the contents-page and section-heading scanners -- requirements.ts
// even labelled its copy a "MIRROR of lib/grants/allowable-uses.ts::normalizeForMatch". They are
// the ENCODING fold and the anchoring primitives that both quote gates turn on, so a drift between
// the two copies would silently change which quotes verify. One definition, imported by both.
//
// What stays LOCAL to each caller, on purpose: the section-heading PATTERNS (allowable-costs vs.
// application/review headings differ), the excerpt/window selection (one dense window + a hedge vs.
// head + up to two anchored windows), and the line tidier (allowable-uses strips any leading
// enumeration run; requirements deliberately gates the strip so a leading numeral that IS the
// requirement survives). Those genuinely differ and are not shared.

// Quote bounds, shared by both gates: long enough to carry a real clause, short enough that "the
// quote" cannot become "the section"; below the floor a span matches by accident in any long doc.
// requirements.ts documented these as "Same quote bounds as allowable-uses" -- now they are one.
export const MIN_QUOTE_CHARS = 24;
export const MAX_QUOTE_CHARS = 300;

// THE NORMALIZER -- the whole quote gate turns on this, so it is spelled out.
//
// raw_text is extracted from PDFs and HTML, and extraction leaves artifacts that no human would
// call a difference in the text: a sentence broken across a line, a soft hyphen at a page break, a
// non-breaking space in a heading, curly quotes from a word processor, an en-dash in a range. A
// model that copies a span perfectly faithfully still fails a byte-exact includes() against any of
// those. So both sides are folded identically and the match stays EXACT on the folded forms. This
// is not fuzzy matching: no similarity score, no threshold, no partial credit. We only remove
// distinctions that exist in the encoding rather than in the writing. Deliberately NOT case-folded:
// case is part of the text, models reproduce it reliably, and folding it would let "SHALL NOT"
// match "shall not" -- a difference that changes meaning.
export function normalizeForMatch(s: string): string {
  return (
    s
      // Soft hyphen, zero-width space/non-joiner/joiner, BOM, word joiner.
      .replace(/[­​‌‍﻿⁠]/g, "")
      // Hyphenation across a line break: "appropri-\nate" is one word in the source.
      .replace(/-[\r\n]+\s*/g, "")
      // Curly quotes and primes to ASCII.
      .replace(/[‘’‚‛′]/g, "'")
      .replace(/[“”„‟″]/g, '"')
      // Dash family (figure, en, em, minus, non-breaking hyphen) to ASCII hyphen.
      .replace(/[‐‑‒–—―−]/g, "-")
      // Ellipsis to three dots, so a quote that spells it either way still matches.
      .replace(/…/g, "...")
      // Every whitespace run -- including NBSP and newlines -- to one space.
      .replace(/[\s ]+/g, " ")
      .trim()
  );
}

// A contents-page line is not a section heading, and it beats the real one by tens of thousands of
// characters when it is not excluded. Recognisable by SHAPE rather than wording: the line is short
// and ends in a page number set off by a dot leader or a column gap. Deliberately conservative -- a
// false negative loses the density vote anyway; a false positive discards a real, high-value hit.
function looksLikeTocEntry(raw: string, index: number): boolean {
  const from = raw.lastIndexOf("\n", index) + 1;
  const to = raw.indexOf("\n", index);
  const line = raw.slice(from, to === -1 ? raw.length : to).trim();
  if (line.length > 120) return false;
  // "IV. Allowable Costs .......... 41"
  if (/(?:\.\s?){3,}\s*\d{1,4}$/.test(line)) return true;
  // "Allowable Costs      41" -- column-aligned, two or more spaces or a tab.
  return /(?:\s{2,}|\t)\d{1,4}$/.test(line);
}

// Every section-heading occurrence in the document, contents-page entries removed, sorted. The
// patterns are the caller's own (allowable-costs headings vs. application/review headings), passed
// in rather than module-global so this one scanner serves both gates.
//
// GLOBAL patterns, and lastIndex is reset per call: these regexes are reused across documents, so a
// stale lastIndex from a previous grant would silently skip the head of this one.
export function sectionHits(raw: string, patterns: RegExp[]): number[] {
  const hits: number[] = [];
  for (const re of patterns) {
    // Fresh lastIndex per document: these regexes are module-level and global, so a stale
    // lastIndex from a previous grant would silently skip the head of this one.
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(raw)) !== null) {
      if (!looksLikeTocEntry(raw, m.index)) hits.push(m.index);
      // A zero-length match cannot happen with these patterns, but an unguarded global exec
      // loop is one edit away from spinning forever.
      if (m.index === re.lastIndex) re.lastIndex++;
    }
  }
  return hits.sort((a, b) => a - b);
}
