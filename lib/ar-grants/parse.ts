// Pure parsing + hashing for the AR scraper. No I/O, no DB — so change detection, link extraction,
// and RSS parsing are all unit-tested against fixture strings, offline.
//
// TWO JOBS:
//   1. normalizeForHash + sha256hex → a STABLE content hash per source, so a cosmetic markup change
//      (a rotated banner, a changed nonce) does not read as "the opportunities changed", but a real
//      text change does. This is the change-detection signal.
//   2. extractAnchors / parseRssItems → the candidate hits on a page. Deliberately a LOOSE extractor:
//      it pulls every link + nearby text, and classify.ts decides which are opportunities/loans/PDFs.
//      Missing or over-including a link is harmless (classify filters, and the hash is the primary
//      change signal); it is never a security surface (the extracted URLs are only ever fetched
//      through the SSRF-guarded fetchWebsite, and only .-scheme http/https).

import { createHash } from "node:crypto";
import { XMLParser } from "fast-xml-parser";

// A raw detected hit, before classification. `context` is a short window of text near the link so a
// deadline ("Applications due June 30") sitting beside an anchor can inform the item hash + class.
export interface RawItem {
  title: string;
  url: string | null; // absolute URL, or null for a list-only hit with no link
  context: string;
  isPdf: boolean;
  publishedAt?: string | null; // RSS pubDate, when present
}

export function sha256hex(s: string): string {
  return createHash("sha256").update(s, "utf8").digest("hex");
}

// Strip scripts/styles/tags, decode a few common entities, collapse whitespace, lowercase. The point
// is a hash that tracks VISIBLE TEXT, not markup — stable across cosmetic churn, sensitive to content.
export function normalizeForHash(html: string): string {
  return stripToText(html).toLowerCase();
}

// Shared HTML → visible-text reduction (also used for per-item context and the promote preamble body).
export function stripToText(html: string): string {
  return html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&quot;/gi, '"')
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/\s+/g, " ")
    .trim();
}

// Anchors that are never opportunities — nav/social/utility. Cheap pre-filter so the item set the
// classifier sees is mostly signal. classify.ts still makes the final opportunity/loan/pdf call.
const SKIP_HREF = /^(#|mailto:|tel:|javascript:)/i;
const SKIP_TEXT = /^(home|about|contact|search|login|sign in|menu|skip to|facebook|twitter|x|instagram|youtube|linkedin|privacy|terms|accessibility)$/i;

// Loose anchor extractor. For each <a href>, capture the link text, resolve the URL against baseUrl,
// and grab ~200 chars of trailing text as context. Anchors with no usable href/text are dropped.
export function extractAnchors(html: string, baseUrl: string): RawItem[] {
  const items: RawItem[] = [];
  const seen = new Set<string>();
  const re = /<a\b[^>]*?href\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    const rawHref = m[1].trim();
    const title = stripToText(m[2]).slice(0, 300);
    if (!rawHref || SKIP_HREF.test(rawHref)) continue;
    if (!title || SKIP_TEXT.test(title)) continue;

    let abs: string;
    try {
      abs = new URL(rawHref, baseUrl).toString();
    } catch {
      continue;
    }
    if (abs.startsWith("mailto:") || abs.startsWith("tel:")) continue;
    // Dedup by (url + title) so the same nav link repeated in header/footer counts once.
    const key = `${abs}|${title.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);

    // Trailing context: text immediately after this anchor (a deadline often follows a link).
    const after = html.slice(re.lastIndex, re.lastIndex + 600);
    const context = `${title} ${stripToText(after).slice(0, 200)}`.trim();
    items.push({ title, url: abs, context, isPdf: /\.pdf(\?|#|$)/i.test(abs) });
  }
  return items;
}

// RSS/Atom → items, via fast-xml-parser (decision 4 — a small, well-known parser over hand-rolled
// regex, which mishandles CDATA and Atom-vs-RSS). Tolerant of both <item> (RSS) and <entry> (Atom).
export function parseRssItems(xml: string): RawItem[] {
  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: "@_",
    trimValues: true,
  });
  let doc: unknown;
  try {
    doc = parser.parse(xml);
  } catch {
    return [];
  }
  const rows = [...collectByKey(doc, "item"), ...collectByKey(doc, "entry")];
  const out: RawItem[] = [];
  const seen = new Set<string>();
  for (const r of rows) {
    if (!r || typeof r !== "object") continue;
    const row = r as Record<string, unknown>;
    const title = textOf(row.title).slice(0, 300);
    const link = rssLink(row);
    const published = textOf(row.pubDate) || textOf(row.published) || textOf(row.updated) || null;
    const desc = stripToText(textOf(row.description) || textOf(row.summary) || "").slice(0, 200);
    if (!title && !link) continue;
    const key = `${link ?? ""}|${title.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      title: title || "(untitled)",
      url: link,
      context: `${title} ${desc}`.trim(),
      isPdf: !!link && /\.pdf(\?|#|$)/i.test(link),
      publishedAt: published,
    });
  }
  return out;
}

// --- small helpers over the parsed XML tree ---

function collectByKey(node: unknown, key: string): unknown[] {
  const found: unknown[] = [];
  const walk = (n: unknown) => {
    if (!n || typeof n !== "object") return;
    if (Array.isArray(n)) {
      for (const c of n) walk(c);
      return;
    }
    for (const [k, v] of Object.entries(n as Record<string, unknown>)) {
      if (k === key) {
        if (Array.isArray(v)) found.push(...v);
        else found.push(v);
      }
      walk(v);
    }
  };
  walk(node);
  return found;
}

function textOf(v: unknown): string {
  if (v == null) return "";
  if (typeof v === "string") return v.trim();
  if (typeof v === "number") return String(v);
  if (typeof v === "object") {
    const o = v as Record<string, unknown>;
    if (typeof o["#text"] === "string") return (o["#text"] as string).trim();
  }
  return "";
}

// RSS <link>text</link> vs Atom <link href="..."/>. Prefer an href attribute, else the text.
function rssLink(row: Record<string, unknown>): string | null {
  const l = row.link;
  if (typeof l === "string" && l.trim()) return l.trim();
  if (Array.isArray(l)) {
    for (const el of l) {
      const href = (el as Record<string, unknown>)?.["@_href"];
      if (typeof href === "string" && href.trim()) return href.trim();
    }
  }
  if (l && typeof l === "object") {
    const href = (l as Record<string, unknown>)["@_href"];
    if (typeof href === "string" && href.trim()) return href.trim();
    const t = textOf(l);
    if (t) return t;
  }
  const guid = textOf(row.guid);
  return guid && /^https?:\/\//i.test(guid) ? guid : null;
}
