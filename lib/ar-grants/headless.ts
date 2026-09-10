// Headless render for JS-rendered AR sources (fetch_mode:'headless'). Some source pages (AEDC, DFA)
// inject their opportunity content client-side, so a plain server-HTML GET reads an empty shell. This
// renders the page in headless Chromium and returns the POST-JS DOM as HTML; fetch.ts then runs the
// SAME extractAnchors + classify path over it, so nothing downstream changes.
//
// It REUSES the alert PDF's proven serverless Chromium launcher (launchAlertBrowser) — no new
// dependency, no new binary. The launch is dynamically imported so puppeteer-core is pulled into a
// function's bundle only when a render actually runs, and so a caller that only needs the pure helpers
// (or a unit test) never loads the browser stack.
//
// SAFETY: page.goto navigates the browser directly, bypassing fetchWebsite's SSRF guard, so the guard
// is re-applied here — the target host is DNS-resolved and must be public BEFORE launch, and page JS
// is blocked from reaching a private/loopback IP literal via request interception. The AR source URLs
// are also a fixed, code-reviewed registry (not user input), which is the primary protection.

import { isIP } from "node:net";
import { lookup as dnsLookup } from "node:dns/promises";
import type { Browser } from "puppeteer-core";
import { hostResolvesPublic, isBlockedAddress, type LookupFn } from "@/lib/net/ssrf-guard";

// Bounded so one render can't eat the cron's 300s budget; a page that renders but holds a connection
// open (a long-poll) still yields its DOM (see the goto catch below), so this is a backstop, not a
// hard fail on every slow socket.
export const RENDER_TIMEOUT_MS = 25_000;

// Subresource types we don't need for text extraction — aborting them cuts egress + render time.
const SKIP_RESOURCE_TYPES = new Set(["image", "media", "font", "stylesheet"]);

// Mirror WEBSITE_MAX_CHARS: bound the DOM handed to extractAnchors so a pathological page can't blow
// memory.
const MAX_RENDERED_CHARS = 400_000;

// Same success/fail shape as fetch.ts's FetchTextFn, so renderHeadless plugs into that seam directly.
export type RenderResult = { ok: true; body: string } | { ok: false; reason: string };

// The minimal puppeteer surface renderHeadless uses — declared structurally so tests can drive it with
// a plain fake (never launching a real browser), and so this module needs no value import of
// puppeteer-core (the type import above is erased at build).
interface RenderRequest {
  resourceType(): string;
  url(): string;
  abort(): Promise<void>;
  continue(): Promise<void>;
}
interface RenderPage {
  setRequestInterception(on: boolean): Promise<void>;
  on(event: "request", handler: (req: RenderRequest) => void): void;
  goto(url: string, opts: { waitUntil: "networkidle2"; timeout: number }): Promise<unknown>;
  content(): Promise<string>;
}
interface RenderBrowser {
  newPage(): Promise<RenderPage>;
  close(): Promise<void>;
}

// ── pure helpers (unit-tested directly) ──────────────────────────────────────────────────────────

// Should this subresource be blocked? Post-JS DOM text only — images/media/fonts/stylesheets are
// dead weight and egress.
export function shouldAbortResource(resourceType: string): boolean {
  return SKIP_RESOURCE_TYPES.has(resourceType);
}

// Is this request host a private/loopback IP LITERAL (page JS trying to reach an internal / cloud-
// metadata endpoint)? A hostname (non-literal) is allowed without a per-subrequest DNS resolve — that
// would be prohibitively slow per subresource, and the registry URL itself is pre-resolved + checked
// before goto. Literal private IPs (127.0.0.1, 169.254.169.254, 10.x, ::1, …) are the reachable SSRF
// vector from inside a rendered page, and isBlockedAddress already enumerates every non-public range.
export function isPrivateHostLiteral(host: string): boolean {
  return isIP(host) !== 0 && isBlockedAddress(host);
}

function hostOf(u: string): string {
  try {
    return new URL(u).hostname;
  } catch {
    return "";
  }
}

function isTimeoutError(err: unknown): boolean {
  return (err as { name?: string })?.name === "TimeoutError";
}

const defaultLookup: LookupFn = async (host) => (await dnsLookup(host, { all: true })).map((r) => ({ address: r.address }));

export interface RenderDeps {
  launch?: () => Promise<Browser>; // injected in tests; defaults to the alert Chromium launcher
  lookup?: LookupFn;
  timeoutMs?: number;
}

// Render `url` and return its post-JS HTML. Never throws — every failure is a typed { ok:false, reason }
// (the fetchGrantSource discipline), so a bad render surfaces as a source that reports 0 with a note,
// never a crashed run.
export async function renderHeadless(url: string, deps: RenderDeps = {}): Promise<RenderResult> {
  const lookup = deps.lookup ?? defaultLookup;
  const timeoutMs = deps.timeoutMs ?? RENDER_TIMEOUT_MS;
  const launch = deps.launch ?? (async () => (await import("@/lib/alerts/render")).launchAlertBrowser());

  // Validate + SSRF pre-check BEFORE launching (page.goto bypasses fetchWebsite's guard).
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { ok: false, reason: "bad_url" };
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return { ok: false, reason: "bad_scheme" };
  if (!(await hostResolvesPublic(parsed.hostname, lookup))) return { ok: false, reason: "blocked_host" };

  let browser: RenderBrowser;
  try {
    browser = (await launch()) as unknown as RenderBrowser;
  } catch {
    return { ok: false, reason: "launch_failed" };
  }
  try {
    const page = await browser.newPage();
    await page.setRequestInterception(true);
    page.on("request", (req) => {
      if (shouldAbortResource(req.resourceType()) || isPrivateHostLiteral(hostOf(req.url()))) {
        void req.abort().catch(() => {});
      } else {
        void req.continue().catch(() => {});
      }
    });
    try {
      await page.goto(url, { waitUntil: "networkidle2", timeout: timeoutMs });
    } catch (err) {
      // networkidle2 timing out usually means the page rendered but holds a connection open — grab
      // the DOM anyway. A hard navigation error (DNS/refused/blocked) has no content → typed fail.
      if (!isTimeoutError(err)) return { ok: false, reason: "render_error" };
    }
    const body = (await page.content()).slice(0, MAX_RENDERED_CHARS);
    return { ok: true, body };
  } catch {
    return { ok: false, reason: "render_error" };
  } finally {
    await browser.close().catch(() => {});
  }
}
