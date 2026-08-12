// A guarded fetch of a public grant source, for GrantBot's future web-fetch tool (Brick A).
//
// PURE AND SELF-CONTAINED, ON PURPOSE. This module is NOT wired into runTurn here -- that is Brick
// B, the invariant change, behind GRANTBOT_WEB_FETCH_ENABLED. Brick A lands the safety-critical
// half on its own so every guard is unit-tested before the model can ever reach it. It performs
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
//   2. IP-RANGE block, FAIL CLOSED. Even an allowlisted host is rejected if it resolves to any
//      address that is not a routable public unicast address -- the full IANA special-use registry
//      for v4, and the v6 equivalents parsed structurally (not by string prefix): both textual forms
//      of IPv4-mapped addresses, 6to4 decoded to its embedded v4, and the non-global v6 ranges.
//      Anything unparseable or unrecognised is blocked.
//   3. BUDGETS. HTTPS-only, a per-request timeout that stays armed THROUGH the body read (with one
//      exception: the PDF parse step runs after the read and pdf-parse does not honour the signal, so
//      it is bounded only by the route's 300s maxDuration -- see the note at the pdfExtract call), a
//      response-size cap, a content-type gate (HTML/text decoded honouring the declared charset;
//      PDF extracted to text via pdf-parse, with parse failure and no-text-layer as typed results).
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

// Content types we read as text, decoded honouring the response's declared charset (legacy .gov
// pages are not all UTF-8). PDF is handled separately (PDF_CONTENT_TYPE) because federal NOFOs are
// PDF-heavy: it is read as bytes and run through pdf-parse, with a typed failure for a PDF that will
// not parse or has no text layer.
export const ALLOWED_CONTENT_TYPES = ["text/html", "application/xhtml+xml", "text/plain"] as const;
export const PDF_CONTENT_TYPE = "application/pdf";

// Explicit non-.gov hosts, if any are ever needed. Everything Shannon named is on the .gov TLD, so
// this is empty today; the suffix rule below covers grants.gov / simpler.grants.gov / sam.gov /
// federalregister.gov / any agency or state .gov. Kept as a seam so a future non-.gov source is a
// one-line addition rather than a rule change.
const EXPLICIT_ALLOWED_HOSTS = new Set<string>([]);

export type FetchFailReason =
  | "bad_scheme" // not https
  | "bad_url" // unparseable request URL, or a redirect to an unparseable Location
  | "not_allowlisted" // host is not a grant source
  | "blocked_host" // resolves to a private/non-public address
  | "blocked_redirect" // a redirect pointed off the allowlist
  | "too_many_redirects"
  | "timeout" // headers or body exceeded the time budget
  | "unsupported_type" // content-type not in ALLOWED_CONTENT_TYPES and not a PDF
  | "pdf_parse_failed" // a PDF whose bytes pdf-parse could not read (corrupt, encrypted, or truncated past the cap)
  | "pdf_no_text" // a PDF that parsed but yielded no text layer (a scanned image) -- refuse to guess its content
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
// True when an IP literal is NOT a routable public unicast address. FAIL CLOSED: anything that is
// not positively recognised as public -- including a string that is not an IP literal at all -- is
// blocked.
export function isBlockedAddress(ip: string): boolean {
  const v = isIP(ip);
  if (v === 4) return isBlockedV4(ip);
  if (v === 6) return isBlockedV6(ip);
  return true;
}

// The IANA IPv4 Special-Purpose Address Registry (the non-global entries) plus multicast/reserved.
// Enumerated rather than "positively determine global", because the block set is finite and stable
// and a missed public range only costs a legitimate fetch, while a missed special range is an SSRF
// hole -- so the conservative direction is to over-block.
function isBlockedV4(ip: string): boolean {
  const parts = ip.split(".").map((n) => Number(n));
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return true;
  const [a, b, c] = parts;
  if (a === 0) return true; // 0.0.0.0/8 "this network"
  if (a === 10) return true; // 10/8 private
  if (a === 100 && b >= 64 && b <= 127) return true; // 100.64/10 CGNAT
  if (a === 127) return true; // 127/8 loopback
  if (a === 169 && b === 254) return true; // 169.254/16 link-local (incl. 169.254.169.254 metadata)
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16/12 private
  if (a === 192 && b === 0 && c === 0) return true; // 192.0.0/24 IETF protocol assignments
  if (a === 192 && b === 0 && c === 2) return true; // 192.0.2/24 TEST-NET-1
  if (a === 192 && b === 88 && c === 99) return true; // 192.88.99/24 6to4 relay anycast (deprecated)
  if (a === 192 && b === 168) return true; // 192.168/16 private
  if (a === 198 && (b === 18 || b === 19)) return true; // 198.18/15 benchmarking
  if (a === 198 && b === 51 && c === 100) return true; // 198.51.100/24 TEST-NET-2
  if (a === 203 && b === 0 && c === 113) return true; // 203.0.113/24 TEST-NET-3
  if (a >= 224) return true; // 224/4 multicast, 240/4 reserved, 255.255.255.255 broadcast
  return false;
}

// Parse an IPv6 literal into its eight 16-bit hextets, handling "::" compression, an optional zone
// id, and an embedded dotted-decimal IPv4 tail (::ffff:a.b.c.d). Returns null if it cannot be parsed
// -- and the caller treats null as blocked, so a parse failure fails closed.
function parseV6(input: string): number[] | null {
  let s = input.toLowerCase();
  const zone = s.indexOf("%");
  if (zone >= 0) s = s.slice(0, zone);

  // Fold an embedded dotted-decimal IPv4 tail into two hex groups, so ::ffff:169.254.169.254 and
  // ::ffff:a9fe:a9fe -- the SAME address in the two legal textual forms -- normalise identically.
  const v4 = s.match(/(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
  if (v4) {
    const oct = v4[1].split(".").map((n) => Number(n));
    if (oct.length !== 4 || oct.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return null;
    const hi = ((oct[0] << 8) | oct[1]).toString(16);
    const lo = ((oct[2] << 8) | oct[3]).toString(16);
    s = s.slice(0, s.length - v4[1].length) + `${hi}:${lo}`;
  }

  const halves = s.split("::");
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(":") : [];
  const tail = halves.length === 2 ? (halves[1] ? halves[1].split(":") : []) : null;

  let groups: string[];
  if (tail === null) {
    groups = head;
  } else {
    const missing = 8 - head.length - tail.length;
    if (missing < 0) return null;
    groups = [...head, ...Array(missing).fill("0"), ...tail];
  }
  if (groups.length !== 8) return null;

  const nums = groups.map((g) => (g === "" ? NaN : parseInt(g, 16)));
  if (nums.some((n) => Number.isNaN(n) || n < 0 || n > 0xffff)) return null;
  return nums;
}

function isBlockedV4Hextets(hi: number, lo: number): boolean {
  return isBlockedV4(`${(hi >> 8) & 0xff}.${hi & 0xff}.${(lo >> 8) & 0xff}.${lo & 0xff}`);
}

function isBlockedV6(ip: string): boolean {
  const h = parseV6(ip);
  if (!h) return true; // unparseable -> block (fail closed)

  const zeroPrefix6 = h[0] === 0 && h[1] === 0 && h[2] === 0 && h[3] === 0 && h[4] === 0;
  // IPv4-mapped ::ffff:x:y -> judge the embedded v4.
  if (zeroPrefix6 && h[5] === 0xffff) return isBlockedV4Hextets(h[6], h[7]);
  // ::, ::1, and IPv4-compatible ::x:y (deprecated) -> all non-global; judge embedded v4 for the rest.
  if (zeroPrefix6 && h[5] === 0) {
    if ((h[6] === 0 && h[7] === 0) || (h[6] === 0 && h[7] === 1)) return true; // :: and ::1
    return isBlockedV4Hextets(h[6], h[7]);
  }
  // 6to4 (2002::/16): its middle two hextets ARE an embedded v4 (2002:WWXX:YYZZ::), the direct
  // analog of ::ffff: -- so 2002:a9fe:a9fe:: is 169.254.169.254. Decode and judge it.
  if (h[0] === 0x2002) return isBlockedV4Hextets(h[1], h[2]);

  // NAT64 well-known prefix 64:ff9b::/96 (RFC 6052): the embedded v4 is the last 32 bits, so
  // 64:ff9b::a9fe:a9fe is 169.254.169.254. Decode and judge it (the /48 local-use form below has a
  // length-dependent embedding and is blocked wholesale instead).
  if (h[0] === 0x0064 && h[1] === 0xff9b && h[2] === 0 && h[3] === 0 && h[4] === 0 && h[5] === 0)
    return isBlockedV4Hextets(h[6], h[7]);

  // Structural non-global ranges. Fail closed: a grant source is normal public unicast, never any of
  // these, so over-blocking only costs an illegitimate fetch. Kept at v4/v6 parity (see isBlockedV4).
  if ((h[0] & 0xffc0) === 0xfe80) return true; // fe80::/10 link-local
  if ((h[0] & 0xffc0) === 0xfec0) return true; // fec0::/10 site-local (deprecated)
  if ((h[0] & 0xfe00) === 0xfc00) return true; // fc00::/7 unique-local
  if ((h[0] & 0xff00) === 0xff00) return true; // ff00::/8 multicast
  if (h[0] === 0x0100 && h[1] === 0 && h[2] === 0 && h[3] === 0) return true; // 100::/64 discard-only
  if (h[0] === 0x2001 && (h[1] & 0xfe00) === 0) return true; // 2001::/23 IETF protocol (incl. Teredo, benchmarking)
  if (h[0] === 0x2001 && h[1] === 0x0db8) return true; // 2001:db8::/32 documentation
  if (h[0] === 0x3fff && (h[1] & 0xf000) === 0) return true; // 3fff::/20 documentation
  if (h[0] === 0x5f00) return true; // 5f00::/16 SRv6
  if (h[0] === 0x0064 && h[1] === 0xff9b && h[2] === 0x0001) return true; // 64:ff9b:1::/48 NAT64 local-use

  // WHITELIST TAIL. Unlike v4 (where the non-special space is exhaustively global unicast, so a
  // denylist is complete), most of the v6 space is reserved/unallocated -- an enumerate-bad list can
  // never be complete, which is why this guard took three rounds of "you missed range X". So after
  // the explicit carve-outs and embedded-v4 decodes above, an address is public ONLY if it falls in
  // 2000::/3, the one range actually assigned as global unicast (RFC 3587). Everything else
  // (9999::, 8000::, 1::, ...) is reserved and blocked -- fail closed BY CONSTRUCTION, which is what
  // the module's contract claims. The documentation/protocol carve-outs that live INSIDE 2000::/3
  // (2001:db8::/32, 2001::/23, 3fff::/20) are already returned above, so they stay blocked.
  return (h[0] & 0xe000) !== 0x2000;
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
// PDF bytes -> extracted text. Injectable so the branch logic is tested without a binary fixture;
// the default runs pdf-parse. A throw here becomes a typed pdf_parse_failed, never a guess.
export type PdfExtract = (bytes: Uint8Array) => Promise<string>;

export interface FetchGrantSourceOptions {
  fetchImpl?: FetchImpl;
  lookup?: LookupFn;
  pdfExtract?: PdfExtract;
  now?: () => string;
  timeoutMs?: number;
  maxBytes?: number;
  maxRedirects?: number;
}

const defaultLookup: LookupFn = async (host) => {
  const res = await dnsLookup(host, { all: true });
  return res.map((r) => ({ address: r.address }));
};

const defaultPdfExtract: PdfExtract = async (bytes) => {
  // Import the LIB entry, not the package index: pdf-parse's index.js runs a debug-mode fixture read
  // when `module.parent` is falsy (as it is in a bundled serverless build), which throws ENOENT. The
  // lib entry is the bare async function with no such side effect. No types ship for the subpath.
  // @ts-expect-error -- pdf-parse ships no declaration for its /lib subpath entry
  const mod = (await import("pdf-parse/lib/pdf-parse.js")) as {
    default: (data: Buffer, options?: unknown) => Promise<{ text: string }>;
  };
  const parsed = await mod.default(Buffer.from(bytes));
  return parsed.text ?? "";
};

// Pull the charset off a Content-Type header (e.g. `text/html; charset=iso-8859-1`), so a legacy
// non-UTF-8 .gov page is decoded correctly rather than blind-decoded as UTF-8. Null -> UTF-8.
function parseCharset(rawContentType: string): string | null {
  const m = /;\s*charset\s*=\s*"?([^";]+)"?/i.exec(rawContentType);
  return m ? m[1].trim().toLowerCase() : null;
}

// A TextDecoder for the declared charset, falling back to UTF-8 for an absent, UTF-8, or unknown
// label (an unrecognised label makes `new TextDecoder` throw). Non-fatal, so undecodable bytes
// become U+FFFD rather than a throw -- a legacy page still reads.
function decoderFor(charset: string | null): TextDecoder {
  if (charset && charset !== "utf-8" && charset !== "utf8") {
    try {
      return new TextDecoder(charset);
    } catch {
      // unknown label -> UTF-8
    }
  }
  return new TextDecoder();
}

function isAbort(err: unknown): boolean {
  return (err as { name?: string })?.name === "AbortError";
}

// ── The orchestration ──────────────────────────────────────────────────────────────────────────────
export async function fetchGrantSource(rawUrl: string, opts: FetchGrantSourceOptions = {}): Promise<FetchResult> {
  const fetchImpl = opts.fetchImpl ?? (globalThis.fetch as unknown as FetchImpl);
  const lookup = opts.lookup ?? defaultLookup;
  const pdfExtract = opts.pdfExtract ?? defaultPdfExtract;
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

    // Guard 3a: the timer stays armed THROUGH the body read (cleared in finally), so a server that
    // returns headers fast then drips the body cannot outlast the budget.
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      let res: Response;
      try {
        res = await fetchImpl(url.toString(), { method: "GET", redirect: "manual", signal: controller.signal });
      } catch (err) {
        if (controller.signal.aborted || isAbort(err)) return { ok: false, reason: "timeout", detail: url.toString() };
        return { ok: false, reason: "fetch_error", detail: err instanceof Error ? err.message : String(err) };
      }

      // Redirect: re-loop with the new target so guards 1 + 2 run against it. Drain the intermediate
      // body so its socket is released rather than left for GC.
      if (res.status >= 300 && res.status < 400) {
        await res.body?.cancel().catch(() => {});
        const loc = res.headers.get("location");
        if (!loc) return { ok: false, reason: "http_error", detail: `redirect ${res.status} with no Location` };
        try {
          current = new URL(loc, url).toString();
        } catch {
          return { ok: false, reason: "bad_url", detail: `invalid redirect location: ${loc}` };
        }
        continue;
      }

      if (res.status < 200 || res.status >= 300) {
        await res.body?.cancel().catch(() => {});
        return { ok: false, reason: "http_error", detail: `status ${res.status}` };
      }

      // Guard 3b: content-type gate.
      const rawContentType = res.headers.get("content-type") ?? "";
      const contentType = rawContentType.split(";")[0].trim().toLowerCase();

      // PDF branch: read the bytes (same size cap + abort signal), extract text via pdf-parse. A PDF
      // that will not parse, or that parsed to no text (a scanned image), is a TYPED failure the
      // model must relay -- never an ok:true with an invented body.
      if (contentType === PDF_CONTENT_TYPE) {
        let read: { bytes: Uint8Array; truncated: boolean };
        try {
          read = await readCappedBytes(res, maxBytes, controller.signal);
        } catch (err) {
          if (controller.signal.aborted || isAbort(err)) return { ok: false, reason: "timeout", detail: url.toString() };
          return { ok: false, reason: "fetch_error", detail: err instanceof Error ? err.message : String(err) };
        }
        let text: string;
        try {
          // The abort timer stays armed, but pdf-parse/pdfjs never inspects controller.signal, so this
          // parse step is the one place FETCH_TIMEOUT_MS is not enforced: a pathologically slow parse of
          // an under-cap PDF is bounded only by the route's maxDuration (300s). True cancellation would
          // need a worker thread that can be killed outright; a Promise.race cannot preempt pdfjs's
          // mostly-synchronous CPU work.
          text = await pdfExtract(read.bytes);
        } catch (err) {
          // A truncated PDF (over the byte cap) usually lands here too: its trailer/xref was cut.
          return { ok: false, reason: "pdf_parse_failed", detail: err instanceof Error ? err.message : String(err) };
        }
        if (!text.trim()) {
          // Don't assert "scanned image" when our own byte cap may be the real cause: a large,
          // text-bearing NOFO cut at MAX_RESPONSE_BYTES can leave pdf-parse with a recovered-but-
          // textless structure. Report the truncation honestly rather than guess a scanned source.
          return read.truncated
            ? { ok: false, reason: "pdf_no_text", detail: "PDF truncated at the size cap before a text layer could be confirmed" }
            : { ok: false, reason: "pdf_no_text", detail: "no extractable text layer (likely a scanned PDF)" };
        }
        return {
          ok: true,
          requestedUrl: rawUrl,
          finalUrl: url.toString(),
          contentType,
          text,
          truncated: read.truncated,
          fetchedAt: now(),
        };
      }

      if (!ALLOWED_CONTENT_TYPES.includes(contentType as (typeof ALLOWED_CONTENT_TYPES)[number])) {
        await res.body?.cancel().catch(() => {});
        return { ok: false, reason: "unsupported_type", detail: contentType || "(none)" };
      }

      // Guard 3c: size cap, under the same abort signal as the header fetch, decoding with the
      // charset the response declared.
      let body: { text: string; truncated: boolean };
      try {
        body = await readCapped(res, maxBytes, controller.signal, parseCharset(rawContentType));
      } catch (err) {
        if (controller.signal.aborted || isAbort(err)) return { ok: false, reason: "timeout", detail: url.toString() };
        return { ok: false, reason: "fetch_error", detail: err instanceof Error ? err.message : String(err) };
      }

      return {
        ok: true,
        requestedUrl: rawUrl,
        finalUrl: url.toString(),
        contentType,
        text: body.text,
        truncated: body.truncated,
        fetchedAt: now(),
      };
    } finally {
      clearTimeout(timer);
    }
  }

  return { ok: false, reason: "too_many_redirects", detail: `exceeded ${maxRedirects} redirects; stopped at ${current}` };
}

// Reject a pending read once the signal aborts, so a slow-drip body is bounded by the same timer as
// the header fetch even if the underlying stream does not itself honour the signal.
function abortRace<T>(p: Promise<T>, signal: AbortSignal): Promise<T> {
  if (!signal) return p;
  return new Promise<T>((resolve, reject) => {
    if (signal.aborted) return reject(makeAbort());
    const onAbort = () => reject(makeAbort());
    signal.addEventListener("abort", onAbort, { once: true });
    p.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
  });
}

function makeAbort(): Error {
  const e = new Error("aborted");
  e.name = "AbortError";
  return e;
}

// Read up to maxBytes from the response, decoding with the given charset (UTF-8 when null) in
// STREAMING mode so a multi-byte sequence split across a chunk boundary -- or across the truncation
// cut -- is not corrupted into a replacement character (the final flush drops an incomplete trailing
// sequence). Falls back to arrayBuffer() when the body is not a readable stream.
async function readCapped(
  res: Response,
  maxBytes: number,
  signal: AbortSignal,
  charset: string | null,
): Promise<{ text: string; truncated: boolean }> {
  const reader = res.body?.getReader?.();
  const decoder = decoderFor(charset);

  if (!reader) {
    // Decode from the raw BYTES (not res.text(), which is always UTF-8) so the charset is honoured.
    const buf = new Uint8Array(await res.arrayBuffer());
    if (buf.length > maxBytes) {
      // stream:true and NO flush: a sequence split by the cut is dropped, not flushed to U+FFFD.
      return { text: decoder.decode(buf.slice(0, maxBytes), { stream: true }), truncated: true };
    }
    return { text: decoder.decode(buf), truncated: false };
  }

  let text = "";
  let total = 0;
  let truncated = false;
  try {
    for (;;) {
      const { done, value } = await abortRace(reader.read(), signal);
      if (done) break;
      if (!value) continue;
      total += value.length;
      if (total > maxBytes) {
        const remaining = maxBytes - (total - value.length);
        if (remaining > 0) text += decoder.decode(value.slice(0, remaining), { stream: true });
        truncated = true;
        break;
      }
      text += decoder.decode(value, { stream: true });
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  // Flush only on a clean end. On truncation the decoder holds the bytes of a sequence split by the
  // cut; NOT flushing drops them, where a flush would emit a U+FFFD replacement char instead.
  if (!truncated) text += decoder.decode();
  return { text, truncated };
}

// Read up to maxBytes of raw bytes -- for the PDF path, which extracts from the binary rather than
// decoding to text. Same streaming size cap and abort behaviour as readCapped.
async function readCappedBytes(
  res: Response,
  maxBytes: number,
  signal: AbortSignal,
): Promise<{ bytes: Uint8Array; truncated: boolean }> {
  const reader = res.body?.getReader?.();

  if (!reader) {
    const buf = new Uint8Array(await res.arrayBuffer());
    return buf.length > maxBytes ? { bytes: buf.slice(0, maxBytes), truncated: true } : { bytes: buf, truncated: false };
  }

  const chunks: Uint8Array[] = [];
  let total = 0;
  let truncated = false;
  try {
    for (;;) {
      const { done, value } = await abortRace(reader.read(), signal);
      if (done) break;
      if (!value) continue;
      if (total + value.length > maxBytes) {
        const remaining = maxBytes - total;
        if (remaining > 0) {
          chunks.push(value.slice(0, remaining));
          total += remaining;
        }
        truncated = true;
        break;
      }
      chunks.push(value);
      total += value.length;
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.length;
  }
  return { bytes: out, truncated };
}
