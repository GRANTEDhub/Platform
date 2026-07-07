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
