import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { renderHeadless, shouldAbortResource, isPrivateHostLiteral, isRequestAllowed, type RenderDeps } from "./headless";
import { fetchSource, type FetchTextFn } from "./fetch";
import type { ArGrantSource } from "./sources";

// ── A fake puppeteer surface — these tests NEVER launch a real browser (the injectable-deps contract) ──
interface ReqCfg {
  resourceType: string;
  url: string;
}
class FakeRequest {
  aborted = false;
  continued = false;
  constructor(private cfg: ReqCfg) {}
  resourceType() {
    return this.cfg.resourceType;
  }
  url() {
    return this.cfg.url;
  }
  abort() {
    this.aborted = true;
    return Promise.resolve();
  }
  continue() {
    this.continued = true;
    return Promise.resolve();
  }
}
class FakePage {
  handler: ((req: FakeRequest) => void) | null = null;
  interception = false;
  gotoCalls: string[] = [];
  constructor(private opts: { html?: string; gotoReject?: unknown }) {}
  setRequestInterception(on: boolean) {
    this.interception = on;
    return Promise.resolve();
  }
  on(_event: "request", h: (req: FakeRequest) => void) {
    this.handler = h;
  }
  goto(url: string) {
    this.gotoCalls.push(url);
    return this.opts.gotoReject ? Promise.reject(this.opts.gotoReject) : Promise.resolve(null);
  }
  content() {
    return Promise.resolve(this.opts.html ?? "<html></html>");
  }
}
class FakeBrowser {
  closed = false;
  page: FakePage;
  constructor(opts: { html?: string; gotoReject?: unknown } = {}) {
    this.page = new FakePage(opts);
  }
  newPage() {
    return Promise.resolve(this.page);
  }
  close() {
    this.closed = true;
    return Promise.resolve();
  }
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const launchOf = (b: FakeBrowser): NonNullable<RenderDeps["launch"]> => (() => Promise.resolve(b)) as any;
const publicLookup = async () => [{ address: "93.184.216.34" }]; // example.com, public
const privateLookup = async () => [{ address: "10.0.0.5" }]; // RFC1918

describe("headless — pure helpers", () => {
  it("shouldAbortResource blocks only the heavy subresources", () => {
    for (const t of ["image", "media", "font", "stylesheet"]) expect(shouldAbortResource(t)).toBe(true);
    for (const t of ["document", "script", "xhr", "fetch", "other"]) expect(shouldAbortResource(t)).toBe(false);
  });
  it("isPrivateHostLiteral catches private/loopback IP LITERALS (incl. bracketed IPv6), allows public IPs and hostnames", () => {
    // "[::1]" is how URL.hostname yields an IPv6 literal — brackets must be stripped or isIP() misses it.
    for (const h of ["127.0.0.1", "169.254.169.254", "10.0.0.1", "192.168.1.1", "::1", "[::1]", "[fe80::1]"]) {
      expect(isPrivateHostLiteral(h)).toBe(true);
    }
    expect(isPrivateHostLiteral("93.184.216.34")).toBe(false); // public IP
    expect(isPrivateHostLiteral("www.arkansasedc.com")).toBe(false); // hostname, not resolved per-subrequest
    expect(isPrivateHostLiteral("")).toBe(false);
  });
});

describe("headless — renderHeadless (fake browser, never a real launch)", () => {
  it("renders the post-JS DOM on success and closes the browser", async () => {
    const b = new FakeBrowser({ html: "<html><body><a href='/apply'>Grant application</a></body></html>" });
    const res = await renderHeadless("https://www.arkansasedc.com/programs-services", { launch: launchOf(b), lookup: publicLookup });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.body).toContain("Grant application");
    expect(b.closed).toBe(true); // always torn down
  });
  it("SSRF: a host resolving to a private address is blocked BEFORE launch", async () => {
    let launched = false;
    const deps: RenderDeps = {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      launch: (() => {
        launched = true;
        return Promise.resolve(new FakeBrowser());
      }) as any,
      lookup: privateLookup,
    };
    const res = await renderHeadless("https://internal.example/x", deps);
    expect(res).toEqual({ ok: false, reason: "blocked_host" });
    expect(launched).toBe(false); // never launched a browser for a blocked host
  });
  it("rejects a bad URL and a non-http(s) scheme without launching", async () => {
    let launched = false;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const launch = (() => {
      launched = true;
      return Promise.resolve(new FakeBrowser());
    }) as any;
    expect(await renderHeadless("not a url", { launch, lookup: publicLookup })).toEqual({ ok: false, reason: "bad_url" });
    expect(await renderHeadless("ftp://x.gov/a", { launch, lookup: publicLookup })).toEqual({ ok: false, reason: "bad_scheme" });
    expect(launched).toBe(false);
  });
  it("a networkidle TIMEOUT still returns the rendered DOM (page rendered but held a connection)", async () => {
    const b = new FakeBrowser({ html: "<html><a href='/g'>Water Grant</a></html>", gotoReject: { name: "TimeoutError" } });
    const res = await renderHeadless("https://www.dfa.arkansas.gov/", { launch: launchOf(b), lookup: publicLookup });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.body).toContain("Water Grant");
    expect(b.closed).toBe(true);
  });
  it("a HARD navigation error returns render_error (no content to salvage)", async () => {
    const b = new FakeBrowser({ gotoReject: new Error("net::ERR_NAME_NOT_RESOLVED") });
    const res = await renderHeadless("https://www.dfa.arkansas.gov/", { launch: launchOf(b), lookup: publicLookup });
    expect(res).toEqual({ ok: false, reason: "render_error" });
    expect(b.closed).toBe(true);
  });
  it("a launch failure is a typed result, never a throw", async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const launch = (() => Promise.reject(new Error("chromium missing"))) as any;
    expect(await renderHeadless("https://www.dfa.arkansas.gov/", { launch, lookup: publicLookup })).toEqual({
      ok: false,
      reason: "launch_failed",
    });
  });
  it("enables request interception and wires the handler to abort/continue", async () => {
    const b = new FakeBrowser({ html: "<html></html>" });
    await renderHeadless("https://www.arkansasedc.com/", { launch: launchOf(b), lookup: publicLookup });
    const handler = b.page.handler!;
    expect(b.page.interception).toBe(true);

    const img = new FakeRequest({ resourceType: "image", url: "https://cdn.example/a.png" });
    const doc = new FakeRequest({ resourceType: "document", url: "https://www.arkansasedc.com/" }); // publicLookup → public
    const ssrf = new FakeRequest({ resourceType: "xhr", url: "http://169.254.169.254/latest/meta-data/" });
    handler(img);
    handler(doc);
    handler(ssrf);
    await new Promise((r) => setTimeout(r, 10)); // interception is async now — let dispositions settle
    expect(img.aborted).toBe(true); // heavy subresource
    expect(doc.continued).toBe(true); // needed for the DOM
    expect(ssrf.aborted).toBe(true); // metadata-endpoint SSRF via page JS
  });
});

describe("headless — isRequestAllowed (subresource / redirect SSRF gate, Codex P1)", () => {
  const pub = async () => [{ address: "93.184.216.34" }];
  const priv = async () => [{ address: "10.0.0.5" }];
  const loopback = async () => [{ address: "127.0.0.1" }];
  it("aborts heavy subresource types regardless of host", async () => {
    expect(await isRequestAllowed("image", "https://good.gov/a.png", pub)).toBe(false);
    expect(await isRequestAllowed("stylesheet", "https://good.gov/s.css", pub)).toBe(false);
  });
  it("aborts a literal private IP without a DNS lookup", async () => {
    let looked = false;
    const spy = async () => {
      looked = true;
      return [{ address: "93.184.216.34" }];
    };
    expect(await isRequestAllowed("xhr", "http://169.254.169.254/latest/meta-data/", spy)).toBe(false);
    expect(await isRequestAllowed("fetch", "http://[::1]/x", spy)).toBe(false); // bracketed IPv6 loopback
    expect(looked).toBe(false); // literal IP → refused before any resolve
  });
  it("aborts a HOSTNAME that resolves to a private address (localhost / DNS-rebinding)", async () => {
    expect(await isRequestAllowed("script", "http://localhost/x", loopback)).toBe(false);
    expect(await isRequestAllowed("fetch", "https://attacker.example/x", priv)).toBe(false);
  });
  it("allows a document/script from a public host", async () => {
    expect(await isRequestAllowed("document", "https://www.arkansasedc.com/", pub)).toBe(true);
    expect(await isRequestAllowed("script", "https://cdn.example/app.js", pub)).toBe(true);
  });
  it("caches the per-host verdict — one lookup per unique host", async () => {
    let n = 0;
    const counting = async () => {
      n++;
      return [{ address: "93.184.216.34" }];
    };
    const cache = new Map<string, boolean>();
    await isRequestAllowed("script", "https://cdn.example/a.js", counting, cache);
    await isRequestAllowed("script", "https://cdn.example/b.js", counting, cache);
    expect(n).toBe(1); // second same-host request served from cache
  });
});

// A silent-failure guard: @sparticuz/chromium is externalized, so a headless route renders ONLY if its
// Chromium binary is traced into the serverless bundle (Codex P1 — else executablePath() 500s /
// launch_failed in prod despite a green build). Lock that both AR routes carry the trace.
describe("next.config — headless AR routes trace the Chromium binary", () => {
  it("both ar-grants routes include @sparticuz/chromium in outputFileTracingIncludes", () => {
    const cfg = readFileSync(path.join(process.cwd(), "next.config.mjs"), "utf8");
    expect(cfg).toMatch(/"\/api\/cron\/ar-grants":\s*\[[^\]]*@sparticuz\/chromium/);
    expect(cfg).toMatch(/"\/api\/admin\/ar-grants":\s*\[[^\]]*@sparticuz\/chromium/);
  });
});

// ── fetchSource headless branch ──
const source = (over: Partial<ArGrantSource> = {}): ArGrantSource => ({
  id: "s1",
  agency: "AEDC",
  url: "https://www.arkansasedc.com/programs-services",
  cluster: "state_agency",
  geo_tag: "AR-statewide",
  elig_tag: "any",
  funding_type: "mixed",
  fetch_mode: "headless",
  active: true,
  last_hash: null,
  last_checked: null,
  last_changed: null,
  ...over,
});

describe("fetchSource — headless mode routes through the renderer, html/rss do not", () => {
  it("headless: renders, extracts anchors, and hashes item identity (not the raw DOM)", async () => {
    const htmlFetchThatMustNotRun: FetchTextFn = async () => {
      throw new Error("html fetch must not run for a headless source");
    };
    const render: FetchTextFn = async () => ({
      ok: true,
      body: "<a href='/apply'>Water Grant application</a><a href='/nofo.pdf'>FY26 NOFO</a>",
    });
    const res = await fetchSource(source(), htmlFetchThatMustNotRun, render);
    expect(res.ok).toBe(true);
    expect(res.items.map((i) => i.url)).toContain("https://www.arkansasedc.com/apply");
    expect(res.contentHash.length).toBeGreaterThan(0);
  });
  it("headless: item-identity hash is stable across DOM churn (SPA nonces don't flip 'changed')", async () => {
    const items = "<a href='/apply'>Water Grant application</a>";
    const a = await fetchSource(source(), undefined, async () => ({ ok: true, body: `<div id="nonce-abc">${items}</div>` }));
    const b = await fetchSource(source(), undefined, async () => ({ ok: true, body: `<section data-ts="9999">  ${items}  </section>` }));
    expect(a.ok && b.ok).toBe(true);
    expect(a.contentHash).toBe(b.contentHash); // same anchors → same hash, despite different wrappers
  });
  it("headless: a render failure surfaces as a typed fetch failure", async () => {
    const res = await fetchSource(source(), undefined, async () => ({ ok: false, reason: "blocked_host" }));
    expect(res.ok).toBe(false);
    expect(res.reason).toBe("blocked_host");
  });
  it("html mode uses the html fetcher, never the renderer", async () => {
    const renderThatMustNotRun: FetchTextFn = async () => {
      throw new Error("renderer must not run for an html source");
    };
    const html: FetchTextFn = async () => ({ ok: true, body: "<a href='/g'>Grant applications open; apply by June 30, 2026</a>" });
    const res = await fetchSource(source({ fetch_mode: "html" }), html, renderThatMustNotRun);
    expect(res.ok).toBe(true);
    expect(res.items.length).toBeGreaterThan(0);
  });
});
