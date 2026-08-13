// A guarded fetch of an ARBITRARY client website, for the enrich/website profile-drafting route.
//
// This is the enrich-side sibling of lib/grantbot/fetch.ts, and it shares the same SSRF core
// (hostResolvesPublic from lib/net/ssrf-guard). The differences from GrantBot are deliberate and
// route-specific:
//   - NO allowlist. GrantBot restricts to the .gov TLD; enrich fetches whatever client site a staffer
//     pastes, so the protection is the resolve-verdict guard alone, not a domain list.
//   - http AND https. GrantBot is https-only; enrich keeps http because rural/county/small-nonprofit
//     client sites are frequently http-only (or http that redirects to https), and https-only would
//     newly reject real sites for no SSRF benefit.
//   - Redirect cap 5 (GrantBot's is 3). Client sites chain apex->www->https->trailing-slash more than
//     .gov does; 3 would false-reject on hop count. Every hop is still fully revalidated.
//
// THE FIX this module delivers (issue #359): the old enrich guard checked the URL hostname STRING
// before any DNS resolution and then followed redirects with `redirect: "follow"`, so a hostname that
// resolves to an internal address, or a public host that 302s to one, sailed through. Here every hop
// is DNS-resolved and every resolved address must be public (hostResolvesPublic), and redirects are
// followed manually so the guard re-runs on each new target.

import { lookup as dnsLookup } from "node:dns/promises";
import { hostResolvesPublic, type LookupFn } from "@/lib/net/ssrf-guard";

export const WEBSITE_FETCH_TIMEOUT_MS = 12_000;
export const WEBSITE_MAX_REDIRECTS = 5;
export const WEBSITE_MAX_CHARS = 400_000;
const DEFAULT_USER_AGENT = "GRANTEDbot/1.0 (+profile drafting)";

export type FetchWebsiteFailReason =
  | "bad_url" // unparseable request URL, or a redirect to an unparseable Location
  | "bad_scheme" // not http(s) (e.g. a redirect to ftp:/data:/mailto:)
  | "blocked_host" // resolves to a private/non-public address (SSRF) -- the enrich fix
  | "too_many_redirects"
  | "timeout"
  | "http_error" // non-2xx final status
  | "fetch_error"; // network/transport failure

export type FetchWebsiteResult =
  | { ok: true; html: string; finalUrl: string; status: number }
  | { ok: false; reason: FetchWebsiteFailReason; status?: number; detail?: string };

export type WebsiteFetchImpl = (
  url: string,
  init: { method: "GET"; redirect: "manual"; signal: AbortSignal; headers: Record<string, string> },
) => Promise<Response>;

export interface FetchWebsiteOptions {
  fetchImpl?: WebsiteFetchImpl;
  lookup?: LookupFn;
  timeoutMs?: number;
  maxRedirects?: number;
  maxChars?: number;
  userAgent?: string;
}

const defaultLookup: LookupFn = async (host) => {
  const res = await dnsLookup(host, { all: true });
  return res.map((r) => ({ address: r.address }));
};

function isAbort(err: unknown): boolean {
  return (err as { name?: string })?.name === "AbortError";
}

export async function fetchWebsite(rawUrl: string, opts: FetchWebsiteOptions = {}): Promise<FetchWebsiteResult> {
  const fetchImpl = opts.fetchImpl ?? (globalThis.fetch as unknown as WebsiteFetchImpl);
  const lookup = opts.lookup ?? defaultLookup;
  const timeoutMs = opts.timeoutMs ?? WEBSITE_FETCH_TIMEOUT_MS;
  const maxRedirects = opts.maxRedirects ?? WEBSITE_MAX_REDIRECTS;
  const maxChars = opts.maxChars ?? WEBSITE_MAX_CHARS;
  const userAgent = opts.userAgent ?? DEFAULT_USER_AGENT;

  // ONE timer for the whole redirect chain (not reset per hop), so total fetch time is bounded at
  // timeoutMs regardless of how many hops -- keeping the cap-5 chain well inside the route's 30s
  // maxDuration.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    let current = rawUrl;
    for (let hop = 0; hop <= maxRedirects; hop++) {
      let url: URL;
      try {
        url = new URL(current);
      } catch {
        return { ok: false, reason: "bad_url", detail: current };
      }
      // Scheme: http OR https (enrich keeps http). A redirect to any other scheme is rejected here.
      if (url.protocol !== "http:" && url.protocol !== "https:") {
        return { ok: false, reason: "bad_scheme", detail: url.protocol };
      }
      // SSRF guard, re-run on EVERY hop: the host must resolve only to public addresses. This is the
      // check the old string-based guard lacked -- a hostname resolving to an internal IP, or a
      // redirect to one, is caught here.
      if (!(await hostResolvesPublic(url.hostname, lookup))) {
        return { ok: false, reason: "blocked_host", detail: url.hostname };
      }

      let res: Response;
      try {
        res = await fetchImpl(url.toString(), {
          method: "GET",
          redirect: "manual",
          signal: controller.signal,
          headers: { "user-agent": userAgent },
        });
      } catch (err) {
        if (controller.signal.aborted || isAbort(err)) return { ok: false, reason: "timeout", detail: url.toString() };
        return { ok: false, reason: "fetch_error", detail: err instanceof Error ? err.message : String(err) };
      }

      // Redirect: re-loop with the resolved target so the guards run against it. Drain the
      // intermediate body so its socket is released rather than left for GC.
      if (res.status >= 300 && res.status < 400) {
        const loc = res.headers.get("location");
        await res.body?.cancel().catch(() => {});
        if (!loc) return { ok: false, reason: "http_error", status: res.status, detail: "redirect with no Location" };
        try {
          current = new URL(loc, url).toString();
        } catch {
          return { ok: false, reason: "bad_url", detail: loc };
        }
        continue;
      }

      if (!res.ok) {
        await res.body?.cancel().catch(() => {});
        return { ok: false, reason: "http_error", status: res.status };
      }

      let html: string;
      try {
        html = (await res.text()).slice(0, maxChars);
      } catch (err) {
        if (controller.signal.aborted || isAbort(err)) return { ok: false, reason: "timeout", detail: url.toString() };
        return { ok: false, reason: "fetch_error", detail: err instanceof Error ? err.message : String(err) };
      }
      return { ok: true, html, finalUrl: url.toString(), status: res.status };
    }
    return { ok: false, reason: "too_many_redirects", detail: `exceeded ${maxRedirects} redirects; stopped at ${current}` };
  } finally {
    clearTimeout(timer);
  }
}
