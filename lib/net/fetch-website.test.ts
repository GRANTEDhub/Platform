import { describe, it, expect } from "vitest";
import { fetchWebsite, type WebsiteFetchImpl } from "./fetch-website";
import { type LookupFn } from "./ssrf-guard";

// Orchestration tests for the enrich guarded fetch. The IP-range verdict itself is proven in
// ssrf-guard.test.ts (the shared core) -- these tests do NOT re-enumerate ranges; they prove the
// resolve-verdict is wired on every hop and the manual redirect loop revalidates each target.

// A lookup that resolves every host to a public address (8.8.8.8) unless a host->ip map overrides it.
function lookupWith(map: Record<string, string> = {}): LookupFn {
  return async (host: string) => [{ address: map[host] ?? "8.8.8.8" }];
}

// A WebsiteFetchImpl from a scripted sequence of responses (one per hop); records the URLs fetched.
function fetchSequence(responses: Response[]): { impl: WebsiteFetchImpl; calls: string[] } {
  const calls: string[] = [];
  let i = 0;
  const impl: WebsiteFetchImpl = async (url) => {
    calls.push(url);
    const res = responses[i++];
    if (!res) throw new Error("no scripted response for hop");
    return res;
  };
  return { impl, calls };
}

const redirectTo = (location: string, status = 302) => new Response(null, { status, headers: { location } });

describe("fetchWebsite — SSRF guard", () => {
  it("fetches a normal public site", async () => {
    const { impl, calls } = fetchSequence([new Response("<html>Acme Nonprofit</html>", { status: 200 })]);
    const r = await fetchWebsite("https://acme.org/", { fetchImpl: impl, lookup: lookupWith() });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.html).toContain("Acme Nonprofit");
      expect(r.finalUrl).toBe("https://acme.org/");
    }
    expect(calls).toEqual(["https://acme.org/"]);
  });

  it("refuses a hostname that RESOLVES to a blocked IP -- the case the old string guard could not catch", async () => {
    // The old isBlockedHost only inspected the literal hostname; a domain pointing at metadata/private
    // space passed. Now the host is resolved and the address is judged.
    const { impl, calls } = fetchSequence([new Response("<html>should never be read</html>", { status: 200 })]);
    const r = await fetchWebsite("https://internal.attacker.example/", {
      fetchImpl: impl,
      lookup: lookupWith({ "internal.attacker.example": "169.254.169.254" }),
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("blocked_host");
    expect(calls).toEqual([]); // blocked BEFORE any network call
  });

  it("re-validates every redirect hop: a public host that 302s to an internal one is caught mid-chain", async () => {
    const { impl, calls } = fetchSequence([
      redirectTo("http://internal.example/"), // hop 0: public host redirects inward
      new Response("<html>should never be read</html>", { status: 200 }), // hop 1: must never be fetched
    ]);
    const r = await fetchWebsite("https://public-site.example/", {
      fetchImpl: impl,
      lookup: lookupWith({ "internal.example": "10.0.0.1" }),
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("blocked_host");
    expect(calls).toEqual(["https://public-site.example/"]); // only hop 0 was fetched
  });

  it("follows a redirect to another PUBLIC host and returns its body", async () => {
    const { impl, calls } = fetchSequence([
      redirectTo("https://www.acme.org/home"),
      new Response("<html>welcome</html>", { status: 200 }),
    ]);
    const r = await fetchWebsite("https://acme.org/", { fetchImpl: impl, lookup: lookupWith() });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.html).toContain("welcome");
      expect(r.finalUrl).toBe("https://www.acme.org/home");
    }
    expect(calls.length).toBe(2);
  });

  it("keeps http:// (does NOT inherit GrantBot's https-only)", async () => {
    const { impl } = fetchSequence([new Response("<html>county site</html>", { status: 200 })]);
    const r = await fetchWebsite("http://smallcounty.gov.example/", { fetchImpl: impl, lookup: lookupWith() });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.html).toContain("county site");
  });

  it("rejects a redirect to a non-web scheme", async () => {
    const { impl } = fetchSequence([redirectTo("ftp://files.example/")]);
    const r = await fetchWebsite("https://acme.org/", { fetchImpl: impl, lookup: lookupWith() });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("bad_scheme");
  });

  it("stops at the redirect cap of 5 (client sites chain more than .gov)", async () => {
    // Six 302s to distinct public paths -> the loop runs hops 0..5, all public, then gives up.
    const { impl, calls } = fetchSequence([
      redirectTo("https://acme.org/1"),
      redirectTo("https://acme.org/2"),
      redirectTo("https://acme.org/3"),
      redirectTo("https://acme.org/4"),
      redirectTo("https://acme.org/5"),
      redirectTo("https://acme.org/6"),
    ]);
    const r = await fetchWebsite("https://acme.org/", { fetchImpl: impl, lookup: lookupWith() });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("too_many_redirects");
    expect(calls.length).toBe(6); // hops 0..5 fetched, hop 6 never attempted
  });

  it("maps a non-2xx final status to http_error with the status", async () => {
    const { impl } = fetchSequence([new Response("nope", { status: 404 })]);
    const r = await fetchWebsite("https://acme.org/", { fetchImpl: impl, lookup: lookupWith() });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toBe("http_error");
      expect(r.status).toBe(404);
    }
  });

  it("blocks a host that resolves to zero addresses (fail closed)", async () => {
    const { impl, calls } = fetchSequence([new Response("<html>x</html>", { status: 200 })]);
    const r = await fetchWebsite("https://nxdomain.example/", { fetchImpl: impl, lookup: async () => [] });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("blocked_host");
    expect(calls).toEqual([]);
  });
});
