import { describe, it, expect } from "vitest";
import {
  fetchGrantSource,
  isAllowlistedHost,
  isBlockedAddress,
  type FetchImpl,
  type LookupFn,
} from "./fetch";

// Brick A guard tests. No network, no model: every guard is exercised through injected seams
// (fetchImpl, lookup) so the safety-critical half is proven before Brick B can wire it into runTurn.

// A lookup that always resolves to a public address, unless a host->ip map says otherwise.
function lookupWith(map: Record<string, string> = {}): LookupFn {
  return async (host: string) => [{ address: map[host] ?? "203.0.113.10" }]; // TEST-NET-3 public literal
}

// Build a fetchImpl from a scripted sequence of responses (one per hop).
function fetchSequence(responses: Response[]): { impl: FetchImpl; calls: string[] } {
  const calls: string[] = [];
  let i = 0;
  const impl: FetchImpl = async (url) => {
    calls.push(url);
    const res = responses[i++];
    if (!res) throw new Error("no scripted response for hop");
    return res;
  };
  return { impl, calls };
}

function htmlResponse(body: string, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(body, { status, headers: { "content-type": "text/html; charset=utf-8", ...headers } });
}

describe("isAllowlistedHost", () => {
  it("allows the named grant sources and any .gov", () => {
    for (const h of ["grants.gov", "simpler.grants.gov", "sam.gov", "www.sam.gov", "federalregister.gov", "arkansas.gov", "transit.dot.gov"]) {
      expect(isAllowlistedHost(h)).toBe(true);
    }
  });
  it("rejects non-.gov and subdomain spoofs", () => {
    for (const h of ["grants.gov.evil.com", "evil.com", "notgov", "gov", "grantsxgov", "example.org", ""]) {
      expect(isAllowlistedHost(h)).toBe(false);
    }
  });
  it("is case- and trailing-dot-insensitive", () => {
    expect(isAllowlistedHost("GRANTS.GOV")).toBe(true);
    expect(isAllowlistedHost("grants.gov.")).toBe(true);
  });
});

describe("isBlockedAddress", () => {
  it("blocks loopback, private, link-local, CGNAT, and cloud metadata", () => {
    for (const ip of ["127.0.0.1", "10.0.0.5", "172.16.0.1", "172.31.255.255", "192.168.1.1", "169.254.169.254", "100.64.0.1", "0.0.0.0", "224.0.0.1"]) {
      expect(isBlockedAddress(ip)).toBe(true);
    }
  });
  it("blocks IPv6 loopback, ULA, link-local, and IPv4-mapped private", () => {
    for (const ip of ["::1", "::", "fc00::1", "fd12:3456::1", "fe80::1", "::ffff:10.0.0.1", "::ffff:169.254.169.254"]) {
      expect(isBlockedAddress(ip)).toBe(true);
    }
  });
  it("allows routable public addresses", () => {
    for (const ip of ["203.0.113.10", "8.8.8.8", "172.15.0.1", "172.32.0.1", "2606:2800:220:1::1"]) {
      expect(isBlockedAddress(ip)).toBe(false);
    }
  });
  it("blocks anything that is not an IP literal", () => {
    expect(isBlockedAddress("grants.gov")).toBe(true);
    expect(isBlockedAddress("")).toBe(true);
  });
});

describe("fetchGrantSource — allowlist", () => {
  it("fetches an allowlisted host", async () => {
    const { impl } = fetchSequence([htmlResponse("<html>NOFO</html>")]);
    const r = await fetchGrantSource("https://grants.gov/nofo/123", { fetchImpl: impl, lookup: lookupWith(), now: () => "T" });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.text).toContain("NOFO");
      expect(r.finalUrl).toBe("https://grants.gov/nofo/123");
      expect(r.truncated).toBe(false);
      expect(r.fetchedAt).toBe("T");
    }
  });
  it("rejects a non-allowlisted host without ever calling fetch", async () => {
    const { impl, calls } = fetchSequence([htmlResponse("should not be reached")]);
    const r = await fetchGrantSource("https://evil.com/x", { fetchImpl: impl, lookup: lookupWith() });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("not_allowlisted");
    expect(calls).toHaveLength(0);
  });
  it("rejects a non-https scheme", async () => {
    const { impl } = fetchSequence([]);
    const r = await fetchGrantSource("http://grants.gov/x", { fetchImpl: impl, lookup: lookupWith() });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("bad_scheme");
  });
});

describe("fetchGrantSource — redirects", () => {
  it("follows an allowlisted redirect", async () => {
    const { impl, calls } = fetchSequence([
      htmlResponse("", 302, { location: "https://simpler.grants.gov/final" }),
      htmlResponse("<html>final</html>"),
    ]);
    const r = await fetchGrantSource("https://grants.gov/start", { fetchImpl: impl, lookup: lookupWith() });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.finalUrl).toBe("https://simpler.grants.gov/final");
    expect(calls).toHaveLength(2);
  });
  it("catches a redirect that lands off the allowlist", async () => {
    const { impl } = fetchSequence([htmlResponse("", 302, { location: "https://evil.com/steal" })]);
    const r = await fetchGrantSource("https://grants.gov/start", { fetchImpl: impl, lookup: lookupWith() });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("blocked_redirect");
  });
  it("catches a redirect to an allowlisted host that resolves to a private range", async () => {
    const { impl } = fetchSequence([htmlResponse("", 302, { location: "https://internal.gov/x" })]);
    const r = await fetchGrantSource("https://grants.gov/start", {
      fetchImpl: impl,
      lookup: lookupWith({ "internal.gov": "10.0.0.9" }),
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("blocked_host");
  });
  it("stops after too many redirects", async () => {
    const { impl } = fetchSequence([
      htmlResponse("", 302, { location: "https://grants.gov/a" }),
      htmlResponse("", 302, { location: "https://grants.gov/b" }),
      htmlResponse("", 302, { location: "https://grants.gov/c" }),
    ]);
    const r = await fetchGrantSource("https://grants.gov/start", { fetchImpl: impl, lookup: lookupWith(), maxRedirects: 2 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("too_many_redirects");
  });
});

describe("fetchGrantSource — private-range block on the first hop", () => {
  it("blocks an allowlisted host that resolves to a private address", async () => {
    const { impl, calls } = fetchSequence([htmlResponse("unreachable")]);
    const r = await fetchGrantSource("https://grants.gov/x", {
      fetchImpl: impl,
      lookup: lookupWith({ "grants.gov": "169.254.169.254" }),
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("blocked_host");
    expect(calls).toHaveLength(0); // blocked before any network call
  });
});

describe("fetchGrantSource — timeout", () => {
  it("maps an aborted request to timeout", async () => {
    const impl: FetchImpl = (_url, init) =>
      new Promise((_resolve, reject) => {
        init.signal.addEventListener("abort", () => {
          const e = new Error("aborted");
          e.name = "AbortError";
          reject(e);
        });
      });
    const r = await fetchGrantSource("https://grants.gov/slow", { fetchImpl: impl, lookup: lookupWith(), timeoutMs: 5 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("timeout");
  });
});

describe("fetchGrantSource — size cap", () => {
  it("truncates a response over the cap and declares it", async () => {
    const big = "x".repeat(500);
    const { impl } = fetchSequence([htmlResponse(big)]);
    const r = await fetchGrantSource("https://grants.gov/big", { fetchImpl: impl, lookup: lookupWith(), maxBytes: 100 });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.truncated).toBe(true);
      expect(r.text.length).toBe(100);
    }
  });
  it("does not flag truncation under the cap", async () => {
    const { impl } = fetchSequence([htmlResponse("small")]);
    const r = await fetchGrantSource("https://grants.gov/small", { fetchImpl: impl, lookup: lookupWith(), maxBytes: 100 });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.truncated).toBe(false);
  });
});

describe("fetchGrantSource — content-type gate", () => {
  it("accepts text/html and text/plain", async () => {
    for (const ct of ["text/html; charset=utf-8", "text/plain"]) {
      const { impl } = fetchSequence([new Response("ok", { status: 200, headers: { "content-type": ct } })]);
      const r = await fetchGrantSource("https://grants.gov/x", { fetchImpl: impl, lookup: lookupWith() });
      expect(r.ok).toBe(true);
    }
  });
  it("rejects application/pdf and other unsupported types (deferred to Brick B)", async () => {
    for (const ct of ["application/pdf", "application/octet-stream", "image/png"]) {
      const { impl } = fetchSequence([new Response("bytes", { status: 200, headers: { "content-type": ct } })]);
      const r = await fetchGrantSource("https://grants.gov/x", { fetchImpl: impl, lookup: lookupWith() });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.reason).toBe("unsupported_type");
    }
  });
});

describe("fetchGrantSource — http errors", () => {
  it("maps a non-2xx status to http_error", async () => {
    const { impl } = fetchSequence([htmlResponse("not found", 404)]);
    const r = await fetchGrantSource("https://grants.gov/missing", { fetchImpl: impl, lookup: lookupWith() });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("http_error");
  });
  it("maps a transport failure to fetch_error", async () => {
    const impl: FetchImpl = async () => {
      throw new Error("ECONNRESET");
    };
    const r = await fetchGrantSource("https://grants.gov/x", { fetchImpl: impl, lookup: lookupWith() });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("fetch_error");
  });
});
