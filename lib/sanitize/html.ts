import sanitizeHtml from "sanitize-html";

// Central HTML sanitizer for rich text fields (e.g. grant.description) that carry
// markup. Some source descriptions contain HTML (<p>, <strong>, ...); rendered as
// escaped React children they show as literal tags, and esc()'d into the alert
// PDF they show as literal tags to the client. Sanitize to a tight whitelist,
// then inject -- shared by the review/detail pages and the alert PDF so both
// treat the same field identically.
//
// Uses sanitize-html (pure JS, htmlparser2) -- NOT a DOM-based sanitizer. An
// earlier isomorphic-dompurify version dragged in jsdom, which Next could not
// bundle into the server components/route runtime and 500'd every grant page in
// production. sanitize-html has no jsdom/native deps, so it bundles cleanly into
// RSC + serverless with no externalizing.

// Inline + minimal block formatting only. No attributes/links/images/scripts --
// anything outside the list is discarded, its text content kept.
const RICH: sanitizeHtml.IOptions = {
  allowedTags: ["p", "strong", "em", "ul", "ol", "li", "br"],
  allowedAttributes: {},
  disallowedTagsMode: "discard",
};

const TEXT: sanitizeHtml.IOptions = {
  allowedTags: [],
  allowedAttributes: {},
  disallowedTagsMode: "discard",
};

// DOCUMENT-grade profile for GrantBot artifacts (a whole HTML deliverable, not an inline snippet).
// SAME engine as RICH -- sanitize-html, pure JS, htmlparser2 -- honouring the locked "never
// jsdom/dompurify" rule (see the header). This is a wider WHITELIST, not a new sanitiser: it adds the
// structural vocabulary a concept proposal needs (headings, tables, lists, blockquotes, rules, links)
// while still discarding everything not named -- keeping the text content of a stripped tag.
//
// DELIBERATELY EXCLUDED: `style` / `<style>` / inline CSS, `script`, event handlers, and (in 1a)
// `img`. Brick 1 is PLAIN, not house-styled -- brand fidelity is the future "Brander" build -- so the
// panel supplies a fixed document stylesheet targeting these semantic tags rather than trusting
// author CSS. That keeps the sanitised blob free of the highest-risk surface (arbitrary CSS/JS) while
// the document still reads as a structured document. `a[href]` is allowed only for http(s)/mailto/tel.
const DOCUMENT: sanitizeHtml.IOptions = {
  allowedTags: [
    "p", "strong", "em", "u", "s", "sub", "sup", "br", "hr",
    "h1", "h2", "h3", "h4", "h5", "h6",
    "ul", "ol", "li",
    "blockquote", "pre", "code",
    "table", "thead", "tbody", "tfoot", "tr", "th", "td", "caption", "colgroup", "col",
    "a", "span", "div", "section", "article", "header", "footer",
  ],
  allowedAttributes: {
    a: ["href"],
    th: ["colspan", "rowspan", "scope"],
    td: ["colspan", "rowspan"],
    col: ["span"],
    // A constrained class vocabulary the panel stylesheet can target. No style/id/data-* attributes.
    "*": ["class"],
  },
  allowedSchemes: ["http", "https", "mailto", "tel"],
  disallowedTagsMode: "discard",
};

// Sanitise a full HTML document to the DOCUMENT whitelist. Applied on WRITE (the artifact tool
// handler) so the stored source is already safe, and the same stored HTML is what the panel renders
// and the exports (1b) consume -- one sanitised source of truth.
export function sanitizeDocument(html: string | null | undefined): string {
  if (!html) return "";
  return sanitizeHtml(html, DOCUMENT);
}

export function sanitizeRichText(html: string | null | undefined): string {
  if (!html) return "";
  return sanitizeHtml(html, RICH);
}

// Plain-text -> HTML-safe string (all tags stripped, entities encoded). Use where
// a value must be embedded into HTML as literal text (e.g. a funder name matched
// inside already-sanitized copy, or a title fallback).
export function sanitizeText(s: string | null | undefined): string {
  if (!s) return "";
  return sanitizeHtml(s, TEXT);
}
