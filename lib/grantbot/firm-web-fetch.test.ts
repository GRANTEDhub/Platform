import { describe, it, expect, afterEach } from "vitest";
import {
  firmWebFetchEnabled,
  FIRM_FETCH_INSTRUCTION_BLOCK,
  WEB_FETCH_TOOL,
  WEB_FETCH_TOOL_NAME,
  executeWebFetch,
} from "./firm-web-fetch";
import {
  WEB_FETCH_TOOL as SHARED_WEB_FETCH_TOOL,
  executeWebFetch as sharedExecuteWebFetch,
} from "./web-fetch";

// Deterministic — no model, no network. Locks the firm web-fetch wiring:
//   ① it REUSES the per-client tool + executor verbatim (identity — no rebuild).
//   ② its OWN flag GRANTBOT_FIRM_WEB_FETCH_ENABLED, default off, INDEPENDENT of the per-client flag.
//   ③ a firm-appropriate instruction block: names the tool + .gov-only + untrusted frame, and does NOT
//      use the per-client "you have no tools" / "your ONLY tool" framing (false on the firm surface).

describe("firm web-fetch reuses the per-client tool + executor (no rebuild)", () => {
  it("re-exports the SAME tool object and executor as web-fetch.ts", () => {
    expect(WEB_FETCH_TOOL).toBe(SHARED_WEB_FETCH_TOOL);
    expect(executeWebFetch).toBe(sharedExecuteWebFetch);
    expect(WEB_FETCH_TOOL_NAME).toBe("fetch_grant_source");
  });
});

describe("firmWebFetchEnabled", () => {
  const prevFirm = process.env.GRANTBOT_FIRM_WEB_FETCH_ENABLED;
  const prevClient = process.env.GRANTBOT_WEB_FETCH_ENABLED;
  afterEach(() => {
    if (prevFirm === undefined) delete process.env.GRANTBOT_FIRM_WEB_FETCH_ENABLED;
    else process.env.GRANTBOT_FIRM_WEB_FETCH_ENABLED = prevFirm;
    if (prevClient === undefined) delete process.env.GRANTBOT_WEB_FETCH_ENABLED;
    else process.env.GRANTBOT_WEB_FETCH_ENABLED = prevClient;
  });

  it("is off by default and off for anything but the literal 'true'", () => {
    delete process.env.GRANTBOT_FIRM_WEB_FETCH_ENABLED;
    expect(firmWebFetchEnabled()).toBe(false);
    for (const v of ["1", "TRUE", "yes", "false", ""]) {
      process.env.GRANTBOT_FIRM_WEB_FETCH_ENABLED = v;
      expect(firmWebFetchEnabled()).toBe(false);
    }
    process.env.GRANTBOT_FIRM_WEB_FETCH_ENABLED = "true";
    expect(firmWebFetchEnabled()).toBe(true);
  });

  it("is INDEPENDENT of the per-client GRANTBOT_WEB_FETCH_ENABLED", () => {
    delete process.env.GRANTBOT_FIRM_WEB_FETCH_ENABLED;
    process.env.GRANTBOT_WEB_FETCH_ENABLED = "true"; // per-client fetch on…
    expect(firmWebFetchEnabled()).toBe(false); // …firm fetch stays off
  });
});

describe("FIRM_FETCH_INSTRUCTION_BLOCK", () => {
  const text = FIRM_FETCH_INSTRUCTION_BLOCK.text;

  it("is non-cacheable and kind 'web-fetch'", () => {
    expect(FIRM_FETCH_INSTRUCTION_BLOCK.cacheable).toBe(false);
    expect(FIRM_FETCH_INSTRUCTION_BLOCK.kind).toBe("web-fetch");
  });

  it("names the tool, states .gov-only + read-only, frames fetched text as untrusted, forbids guessing on failure", () => {
    expect(text).toContain(WEB_FETCH_TOOL_NAME);
    expect(text).toMatch(/\.gov/);
    expect(text).toMatch(/read-only/i);
    expect(text).toMatch(/untrusted|PASTED CONTENT/);
    expect(text).toMatch(/never infer|not one to fill from memory|could not read/i);
  });

  it("does NOT use the per-client 'you have no tools' / 'your ONLY tool' framing (false on the firm surface)", () => {
    expect(text).not.toMatch(/you have no tools/i);
    expect(text).not.toMatch(/your only tool|only one tool/i);
  });
});
