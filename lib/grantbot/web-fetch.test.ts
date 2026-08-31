import { describe, it, expect, afterEach } from "vitest";
import {
  frameFetchResult,
  executeWebFetch,
  grantbotWebFetchEnabled,
  FETCH_INSTRUCTION_BLOCK,
  WEB_FETCH_TOOL,
  MAX_FETCH_TEXT_CHARS,
} from "./web-fetch";
import type { FetchResult } from "./fetch";

// The bounded tool-use LOOP is tested in tool-loop.test.ts (it is tool-agnostic now). This file
// covers the fetch tool itself: the flag, the instruction block, and the result framing.

describe("grantbotWebFetchEnabled", () => {
  const prev = process.env.GRANTBOT_WEB_FETCH_ENABLED;
  afterEach(() => {
    if (prev === undefined) delete process.env.GRANTBOT_WEB_FETCH_ENABLED;
    else process.env.GRANTBOT_WEB_FETCH_ENABLED = prev;
  });
  it("is off by default and off for anything but the literal 'true'", () => {
    delete process.env.GRANTBOT_WEB_FETCH_ENABLED;
    expect(grantbotWebFetchEnabled()).toBe(false);
    for (const v of ["1", "TRUE", "yes", "false", ""]) {
      process.env.GRANTBOT_WEB_FETCH_ENABLED = v;
      expect(grantbotWebFetchEnabled()).toBe(false);
    }
    process.env.GRANTBOT_WEB_FETCH_ENABLED = "true";
    expect(grantbotWebFetchEnabled()).toBe(true);
  });
});

describe("FETCH_INSTRUCTION_BLOCK", () => {
  it("is non-cacheable so it stays out of the shared cached prefix", () => {
    expect(FETCH_INSTRUCTION_BLOCK.cacheable).toBe(false);
    expect(FETCH_INSTRUCTION_BLOCK.kind).toBe("web-fetch");
  });
  it("names the one tool and the refuse-to-infer rule", () => {
    expect(FETCH_INSTRUCTION_BLOCK.text).toContain(WEB_FETCH_TOOL.name);
    expect(FETCH_INSTRUCTION_BLOCK.text).toMatch(/could not retrieve/i);
    expect(FETCH_INSTRUCTION_BLOCK.text).toMatch(/never infer|do not fetch idly|untrusted/i);
  });
  it("tells the model to keep the fetch/retry mechanics out of its reply (no play-by-play)", () => {
    // The narration fix (#7): the staffer must not see "404 on that URL, let me try X" — the model
    // should retry silently and surface only the result or a clean could-not-reach line.
    expect(FETCH_INSTRUCTION_BLOCK.text).toMatch(/plumbing/i);
    expect(FETCH_INSTRUCTION_BLOCK.text).toMatch(/play-by-play|narrat/i);
  });
});

describe("frameFetchResult", () => {
  it("wraps a successful fetch in the untrusted PASTED CONTENT frame and audits it", () => {
    const result: FetchResult = {
      ok: true,
      requestedUrl: "https://grants.gov/x",
      finalUrl: "https://grants.gov/final",
      contentType: "text/html",
      text: "NOFO body",
      truncated: false,
      fetchedAt: "2026-08-12T00:00:00Z",
    };
    const { resultText, audit } = frameFetchResult("https://grants.gov/x", result, () => "NOW");
    expect(resultText).toContain("PASTED CONTENT");
    expect(resultText).toContain("NOFO body");
    expect(resultText).toContain("fetched from https://grants.gov/final");
    expect(audit).toEqual({ url: "https://grants.gov/x", ok: true, finalUrl: "https://grants.gov/final", truncated: false, fetchedAt: "2026-08-12T00:00:00Z" });
  });
  it("notes truncation", () => {
    const result: FetchResult = { ok: true, requestedUrl: "u", finalUrl: "u", contentType: "text/html", text: "partial", truncated: true, fetchedAt: "T" };
    const { resultText, audit } = frameFetchResult("u", result, () => "NOW");
    expect(resultText).toMatch(/truncated/i);
    expect(audit.truncated).toBe(true);
  });
  it("caps oversized fetched text for the model and flags it partial", () => {
    const big = "x".repeat(MAX_FETCH_TEXT_CHARS + 5_000);
    const result: FetchResult = { ok: true, requestedUrl: "u", finalUrl: "u", contentType: "text/html", text: big, truncated: false, fetchedAt: "T" };
    const { resultText, audit } = frameFetchResult("u", result, () => "NOW");
    expect(resultText).not.toContain(big);
    expect((resultText.match(/x/g) ?? []).length).toBe(MAX_FETCH_TEXT_CHARS);
    expect(resultText).toMatch(/truncated/i);
    expect(audit.truncated).toBe(true);
  });
  it("leaves text at or under the cap untouched and not flagged partial", () => {
    const result: FetchResult = { ok: true, requestedUrl: "u", finalUrl: "u", contentType: "text/html", text: "short body", truncated: false, fetchedAt: "T" };
    const { resultText, audit } = frameFetchResult("u", result, () => "NOW");
    expect(resultText).toContain("short body");
    expect(resultText).not.toMatch(/truncated/i);
    expect(audit.truncated).toBe(false);
  });
  it("does not leave a lone surrogate when the cap splits a surrogate pair", () => {
    const text = "a".repeat(MAX_FETCH_TEXT_CHARS) + "📄" + "b".repeat(10);
    const result: FetchResult = { ok: true, requestedUrl: "u", finalUrl: "u", contentType: "text/html", text, truncated: false, fetchedAt: "T" };
    const { resultText } = frameFetchResult("u", result, () => "NOW");
    expect(resultText).toBe(resultText.toWellFormed());
    expect(resultText).toMatch(/truncated/i);
  });
  it("turns a failure into a typed could-not-retrieve fact that forbids inferring", () => {
    const result: FetchResult = { ok: false, reason: "not_allowlisted", detail: "evil.com" };
    const { resultText, audit } = frameFetchResult("https://evil.com", result, () => "NOW");
    expect(resultText).toMatch(/COULD NOT RETRIEVE/);
    expect(resultText).toContain("not_allowlisted");
    expect(resultText).toMatch(/do not infer/i);
    expect(audit).toEqual({ url: "https://evil.com", ok: false, reason: "not_allowlisted", fetchedAt: "NOW" });
  });
});

describe("executeWebFetch", () => {
  it("refuses a missing url without fetching", async () => {
    let called = false;
    const { resultText, audit } = await executeWebFetch(undefined, {
      fetcher: async () => {
        called = true;
        return { ok: false, reason: "bad_url" };
      },
      now: () => "NOW",
    });
    expect(called).toBe(false);
    expect(audit).toEqual({ url: "", ok: false, reason: "no_url", fetchedAt: "NOW" });
    expect(resultText).toMatch(/no url/i);
  });
  it("fetches through the injected fetcher and frames the result", async () => {
    const { audit } = await executeWebFetch("https://grants.gov/x", {
      fetcher: async (u) => ({ ok: true, requestedUrl: u, finalUrl: u, contentType: "text/html", text: "body", truncated: false, fetchedAt: "T" }),
      now: () => "NOW",
    });
    expect(audit).toMatchObject({ url: "https://grants.gov/x", ok: true });
  });
});
