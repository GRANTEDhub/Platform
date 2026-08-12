// A guarded fetch of a public grant source, for GrantBot's future web-fetch tool (Brick A).
//
// PURE AND SELF-CONTAINED, ON PURPOSE. This module is NOT wired into runTurn here -- that is Brick
// B, the invariant change, behind GRANTBOT_WEB_FETCH_ENABLED. Brick A lands the safety-critical
// half on its own so every guard can be unit-tested before the model can ever reach it. It performs
// no model call and holds no Supabase/filesystem/internal reach -- by construction it can only do an
// outbound HTTPS GET against the allowlist and return text, which is what keeps "GrantBot can fetch
// a grant source" from becoming "GrantBot has tools."
//
// THE THREE GUARDS, and why each exists:
//   1. ALLOWLIST on the resolved host, re-checked on every redirect hop. Only U.S. federal/state
//      grant sources (the .gov TLD, plus a small explicit set). This simultaneously bounds SSRF (a
//      .gov host cannot be an internal address), closes the exfiltration channel (an injected model
//      can only GET allowlisted public URLs -- it cannot POST the context pack anywhere), and keeps
//      the widening honestly small.
//   2. IP-RANGE block. Even an allowlisted host is rejected if it resolves to a private, loopback,
//      link-local or otherwise non-public address -- the SSRF backstop under the allowlist.
//   3. BUDGETS. HTTPS-only, per-request timeout, response-size cap, content-type gate.
//
// EVERY OUTCOME IS A TYPED RESULT, never a throw. This is the structural half of the discipline:
// Brick B hands this result verbatim into the transcript, so "could not retrieve" is a fact the
// model must relay, not a decision it can fake -- the same shape as step 4's nofo_not_retrievable
// sentinel. Instruction alone ("reason only off fetched source") is the prompt-says-so fallacy; the
// typed failure is what carries the weight.

import { lookup as dnsLookup } from "node:dns/promises";
import { isIP } from "node:net";

// ── Budgets ──────────────────────────────────────────────────────────────────────────────────────
export const FETCH_TIMEOUT_MS = 10_000;
export const MAX_RESPONSE_BYTES = 1_500_000; // ~1.5MB of source text, truncated (and declared) past this
export const MAX_REDIRECTS = 3;

// Content types we will read as text. PDF is DELIBERATELY not here: federal NOFOs are PDF-heavy, but
// PDF-to-text extraction (pdf-parse, already a dependency) lands with the wiring in Brick B, tested
// with a binary fixture there, rather than dragging a binary surface into Brick A's pure guard tests.
export const ALLOWED_CONTENT_TYPES = ["text/html", "application/xhtml+xml", "text/plain"] as const;

// Explicit non-.gov hosts, if any are ever needed. Everything Shannon named is on the .gov TLD, so
// this is empty today; the suffix rule below covers grants.gov / simpler.grants.gov / sam.gov /
// federalregister.gov / any agency or state .gov. Kept as a seam so a future non-.gov source is a
// one-line addition rather than a rule change.
const EXPLICIT_ALLOWED_HOSTS = new Set<string>([]);

export type FetchFailReason =
  | "bad_scheme" // not https
  | "bad_url" // unparseable
  | "not_allowlisted" // host is not a grant source
  | "blocked_host" // resolves to a private/non-public address
  | "blocked_redirect" // a redirect pointed off the allowlist
  | "too_many_redirects"
  | "timeout"
  | "too_large" // exceeded the size cap with no usable prefix
  | "unsupported_type" // content-type not in ALLOWED_CONTENT_TYPES
  | "http_error" // non-2xx/3xx status
  | "fetch_error"; // network/transport failure

export type FetchResult =
  | {
      ok: true;
      requestedUrl: string;
      finalUrl: string;
      contentType: string;
      text: string;
      truncated: boolean;
      fetchedAt: string;
    }
  | { ok: false; reason: FetchFailReason; detail?: string };

// ── Pure guard: allowlist ─────────────────────────────────────────────────────────────────────────
//
// Matches on the exact host. "grants.gov.evil.com" ends in ".com", so endsWith(".gov") is false --
// the suffix rule cannot be spoofed by a subdomain trick. A bare "gov" is rejected.
export function isAllowlistedHost(host: string): boolean {
  const h = host.trim().toLowerCase().replace(/\.$/, "");
  if (!h || h === "gov") return false;
  if (EXPLICIT_ALLOWED_HOSTS.has(h)) return true;
  return h.endsWith(".gov");
}

// ── Pure guard: blocked address ─────────────────────────────────────────────────────────────────
//
// True when an IP literal is NOT a routable public address: loopback, private, link-local, CGNAT,
// unspecified, and the IPv6 equivalents (including IPv4-mapped ::ffff:a.b.c.d, checked on the
// embedded v4). Anything not recognised as public is blocked -- fail closed.
export function isBlockedAddress(ip: string): boolean {
  const v = isIP(ip);
  if (v === 4) return isBlockedV4(ip);
  if (v === 6) return isBlockedV6(ip);
  return true; // not an IP literal at all -> block
}

function isBlockedV4(ip: string): boolean {
  const parts = ip.split(".").map((n) => Number(n));
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return true;
  const [a, b] = parts;
  if (a === 0) return true; // 0.0.0.0/8 "this network" / unspecified
  if (a === 10) return true; // private
  if (a === 127) return true; // loopback
  if (a === 169 && b === 254) return true; // link-local (incl. 169.254.169.254 cloud metadata)
  if (a === 172 && b >= 16 && b <= 31) return true; // private
  if (a === 192 && b === 168) return true; // private
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT 100.64/10
  if (a >= 224) return true; // multicast / reserved / broadcast
  return false;
}

function isBlockedV6(ip: string): boolean {
  const lower = ip.toLowerCase();
  // IPv4-mapped/embedded (::ffff:a.b.c.d or ::a.b.c.d) -> judge on the embedded v4.
  const embedded = lower.match(/(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
  if (embedded) return isBlockedV4(embedded[1]);
  if (lower === "::" || lower === "::1") return true; // unspecified / loopback
  if (lower.startsWith("fe80") || lower.startsWith("fe9") || lower.startsWith("fea") || lower.startsWith("feb"))
    return true; // link-local fe80::/10
  if (lower.startsWith("fc") || lower.startsWith("fd")) return true; // unique-local fc00::/7
  if (lower.startsWith("ff")) return true; // multicast
  return false;
}

function hostOf(rawUrl: string): { url: URL } | { error: FetchFailReason } {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return { error: "bad_url" };
  }
  if (url.protocol !== "https:") return { error: "bad_scheme" };
  return { url };
}

// Every address a host resolves to must be public; if any is blocked, block the host. Resolving to
// zero addresses is also a block. Injectable for tests.
async function hostResolvesPublic(host: string, lookup: LookupFn): Promise<boolean> {
  try {
    const addrs = await lookup(host);
    if (!addrs.length) return false;
    return addrs.every((a) => !isBlockedAddress(a.address));
  } catch {
    return false;
  }
}

// ── Injectable seams (defaults are the real ones) ──────────────────────────────────────────────────
export type LookupFn = (host: string) => Promise<{ address: string }[]>;
export type FetchImpl = (url: string, init: { method: "GET"; redirect: "manual"; signal: AbortSignal }) => Promise<Response>;

export interface FetchGrantSourceOptions {
  fetchImpl?: FetchImpl;
  lookup?: LookupFn;
  now?: () => string;
  timeoutMs?: number;
  maxBytes?: number;
  maxRedirects?: number;
}

const defaultLookup: LookupFn = async (host) => {
  const res = await dnsLookup(host, { all: true });
  return res.map((r) => ({ address: r.address }));
};

// ── The orchestration ──────────────────────────────────────────────────────────────────────────────
export async function fetchGrantSource(rawUrl: string, opts: FetchGrantSourceOptions = {}): Promise<FetchResult> {
  const fetchImpl = opts.fetchImpl ?? (globalThis.fetch as unknown as FetchImpl);
  const lookup = opts.lookup ?? defaultLookup;
  const now = opts.now ?? (() => new Date().toISOString());
  const timeoutMs = opts.timeoutMs ?? FETCH_TIMEOUT_MS;
  const maxBytes = opts.maxBytes ?? MAX_RESPONSE_BYTES;
  const maxRedirects = opts.maxRedirects ?? MAX_REDIRECTS;

  let current = rawUrl;
  for (let hop = 0; hop <= maxRedirects; hop++) {
    const parsed = hostOf(current);
    if ("error" in parsed) return { ok: false, reason: parsed.error, detail: current };
    const url = parsed.url;

    // Guard 1: allowlist (re-checked on every hop, so a 302 off the allowlist is caught here).
    if (!isAllowlistedHost(url.hostname)) {
      return { ok: false, reason: hop === 0 ? "not_allowlisted" : "blocked_redirect", detail: url.hostname };
    }
    // Guard 2: the host must resolve only to public addresses.
    if (!(await hostResolvesPublic(url.hostname, lookup))) {
      return { ok: false, reason: "blocked_host", detail: url.hostname };
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let res: Response;
    try {
      res = await fetchImpl(url.toString(), { method: "GET", redirect: "manual", signal: controller.signal });
    } catch (err) {
      clearTimeout(timer);
      if (controller.signal.aborted || (err as { name?: string })?.name === "AbortError") {
        return { ok: false, reason: "timeout", detail: url.toString() };
      }
      return { ok: false, reason: "fetch_error", detail: err instanceof Error ? err.message : String(err) };
    }
    clearTimeout(timer);

    // Redirect: re-loop with the new target so guard 1 + 2 run against it. Location resolved against
    // the current URL so a relative redirect keeps its host.
    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get("location");
      if (!loc) return { ok: false, reason: "http_error", detail: `redirect ${res.status} with no Location` };
      current = new URL(loc, url).toString();
      continue;
    }

    if (res.status < 200 || res.status >= 300) {
      return { ok: false, reason: "http_error", detail: `status ${res.status}` };
    }

    // Guard 3: content-type gate.
    const contentType = (res.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
    if (!ALLOWED_CONTENT_TYPES.includes(contentType as (typeof ALLOWED_CONTENT_TYPES)[number])) {
      return { ok: false, reason: "unsupported_type", detail: contentType || "(none)" };
    }

    // Guard 3: size cap. Stream and stop at the cap, declaring truncation, so a hostile Content-Length
    // cannot force an unbounded read and an oversized-but-useful page still yields its prefix.
    const body = await readCapped(res, maxBytes);
    if (body === null) return { ok: false, reason: "fetch_error", detail: "no body" };

    return {
      ok: true,
      requestedUrl: rawUrl,
      finalUrl: url.toString(),
      contentType,
      text: body.text,
      truncated: body.truncated,
      fetchedAt: now(),
    };
  }

  return { ok: false, reason: "too_many_redirects" };
}

// Read up to maxBytes from the response, decoding as UTF-8, flagging truncation. Falls back to text()
// when the body is not a readable stream (some Response implementations).
async function readCapped(res: Response, maxBytes: number): Promise<{ text: string; truncated: boolean } | null> {
  const reader = res.body?.getReader?.();
  if (!reader) {
    const full = await res.text();
    const enc = new TextEncoder().encode(full);
    if (enc.length > maxBytes) {
      return { text: new TextDecoder().decode(enc.slice(0, maxBytes)), truncated: true };
    }
    return { text: full, truncated: false };
  }
  const chunks: Uint8Array[] = [];
  let total = 0;
  let truncated = false;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    total += value.length;
    if (total > maxBytes) {
      const remaining = maxBytes - (total - value.length);
      if (remaining > 0) chunks.push(value.slice(0, remaining));
      truncated = true;
      await reader.cancel().catch(() => {});
      break;
    }
    chunks.push(value);
  }
  const merged = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
  let offset = 0;
  for (const c of chunks) {
    merged.set(c, offset);
    offset += c.length;
  }
  return { text: new TextDecoder().decode(merged), truncated };
}
