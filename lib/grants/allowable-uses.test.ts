import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { clientAllowableUses } from "./allowable-uses";

// Deterministic — no model, no network. Locks the CLIENT-side visibility contract for the
// allowable-uses section: the client sees the section ONLY when the flag is on AND the list has
// items, and NEVER the "Ask our team" sentinel. Staff keep the sentinel via the unconditional
// readAllowableUses() call on the roadmap (not exercised here — this is the client half).

const FLAG = "ALLOWABLE_USES_CLIENT_VISIBLE";

// A stored jsonb value carrying at least one verified item.
const WITH_LIST = {
  items: [
    { line: "Personnel and fringe", quote: "salaries and fringe benefits of project staff" },
    { line: "Training and travel", quote: "costs of training and related travel" },
  ],
  reason: null,
};

describe("clientAllowableUses", () => {
  let prev: string | undefined;
  beforeEach(() => {
    prev = process.env[FLAG];
  });
  afterEach(() => {
    if (prev === undefined) delete process.env[FLAG];
    else process.env[FLAG] = prev;
  });

  it("returns null when the flag is off, even with a real list", () => {
    delete process.env[FLAG];
    expect(clientAllowableUses(WITH_LIST)).toBeNull();
  });

  it("treats any value other than exactly \"true\" as off", () => {
    for (const v of ["", "1", "TRUE", "false", "yes"]) {
      process.env[FLAG] = v;
      expect(clientAllowableUses(WITH_LIST), `flag=${JSON.stringify(v)}`).toBeNull();
    }
  });

  it("returns the parsed list, items intact, when the flag is on and items exist", () => {
    process.env[FLAG] = "true";
    const out = clientAllowableUses(WITH_LIST);
    expect(out).not.toBeNull();
    expect(out?.items.map((i) => i.line)).toEqual(["Personnel and fringe", "Training and travel"]);
    // The verbatim quote survives for the hover-to-verify tooltip.
    expect(out?.items[0]?.quote).toContain("salaries and fringe benefits");
  });

  it("HIDES a verified-empty result on the client — no section, never the sentinel", () => {
    process.env[FLAG] = "true";
    // The only empty that reaches the client-visible Grant Report today: reference-style NOFOs
    // that govern costs by 2 CFR 200 rather than itemizing them. no_section AND items [] → null.
    expect(clientAllowableUses({ items: [], reason: "no_section" })).toBeNull();
    // The other empties are hidden identically — the client never sees the sentinel for any reason.
    expect(clientAllowableUses({ items: [], reason: "no_raw_text" })).toBeNull();
    expect(clientAllowableUses({ items: [], reason: "all_dropped" })).toBeNull();
  });

  it("returns null on an unparseable / absent column when the flag is on", () => {
    process.env[FLAG] = "true";
    expect(clientAllowableUses(null)).toBeNull();
    expect(clientAllowableUses(undefined)).toBeNull();
    expect(clientAllowableUses("nonsense")).toBeNull();
    // items present but every entry malformed → parses to an empty list → hidden, not the sentinel.
    expect(clientAllowableUses({ items: [{ line: 42 }, { quote: "x" }], reason: null })).toBeNull();
  });
});
