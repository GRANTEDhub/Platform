import DOMPurify from "isomorphic-dompurify";

// Central HTML sanitizer for rich text fields (e.g. grant.description) that carry
// markup. Some source descriptions contain HTML (<p>, <strong>, ...); rendered
// as escaped React children they show as literal tags, and esc()'d into the alert
// PDF they show as literal tags to the client. Sanitize to a tight whitelist,
// then inject -- shared by the review/detail pages and the alert PDF so both
// treat the same field identically. isomorphic-dompurify works server-side
// (these are server components + the server-rendered PDF).

// Inline + minimal block formatting only. No links/images/attributes/styles/
// scripts -- anything outside the list is stripped, its text content kept.
const ALLOWED_TAGS = ["p", "strong", "em", "ul", "ol", "li", "br"];

export function sanitizeRichText(html: string | null | undefined): string {
  if (!html) return "";
  return DOMPurify.sanitize(html, { ALLOWED_TAGS, ALLOWED_ATTR: [] });
}

// Plain-text -> HTML-safe string (all tags stripped, entities encoded). Use where
// a value must be embedded into HTML as literal text (e.g. a funder name matched
// inside already-sanitized copy, or a title fallback).
export function sanitizeText(s: string | null | undefined): string {
  if (!s) return "";
  return DOMPurify.sanitize(s, { ALLOWED_TAGS: [], ALLOWED_ATTR: [] });
}
