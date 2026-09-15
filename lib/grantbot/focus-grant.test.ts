import { describe, it, expect } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { buildFocusGrantBlock, loadFocusGrant, type FocusGrant } from "./focus-grant";

// Deterministic — no model, no network. Covers the grounding block's shape/discipline and the loader's
// row → FocusGrant mapping with an injected fake db (the data-tools seam pattern).

describe("buildFocusGrantBlock — the grant-anchor grounding block", () => {
  const full: FocusGrant = {
    id: "g-1",
    title: "Arkansas Unpaved Roads Program (AURP)",
    funder: "Arkansas Department of Agriculture",
    cfda: "10.902",
    deadline: "March 1, 2026",
    fon: "AURP-2026",
  };

  it("is cacheable:false and appended after the cache breakpoint (a per-turn block)", () => {
    const b = buildFocusGrantBlock(full);
    expect(b.cacheable).toBe(false);
    expect(b.kind).toBe("focus-grant");
    expect(b.source).toBe("lib/grantbot/focus-grant.ts");
  });

  it("names the grant + its key facts and pins the anchor discipline", () => {
    const t = buildFocusGrantBlock(full).text;
    expect(t).toContain("ANCHORED TO ONE GRANT");
    expect(t).toContain("Arkansas Unpaved Roads Program (AURP)");
    expect(t).toContain("Arkansas Department of Agriculture");
    expect(t).toContain("10.902");
    expect(t).toContain("AURP-2026");
    expect(t).toContain("March 1, 2026");
    // The discipline: answer as if named, don't ask which grant.
    expect(t).toMatch(/do NOT ask which grant/i);
    // The grant-advisory distinctions GRANTED cares about.
    expect(t).toMatch(/prime/i);
  });

  it("drops missing facts rather than printing empty lines", () => {
    const bare: FocusGrant = { id: "g-2", title: "Bare Grant", funder: null, cfda: null, deadline: null, fon: null };
    const t = buildFocusGrantBlock(bare).text;
    expect(t).toContain("Bare Grant");
    expect(t).not.toContain("Funder:");
    expect(t).not.toContain("CFDA:");
    expect(t).not.toContain("Submission deadline:");
    expect(t).not.toContain("Opportunity number:");
  });
});

// A minimal fake db: db.from("grants").select(...).eq("id", id).maybeSingle() → { data }.
function fakeDb(row: Record<string, unknown> | null): SupabaseClient {
  const chain = {
    select: () => chain,
    eq: () => chain,
    maybeSingle: async () => ({ data: row }),
  };
  return { from: () => chain } as unknown as SupabaseClient;
}

describe("loadFocusGrant — grant row → FocusGrant", () => {
  it("maps the row and joins the assistance listings into a CFDA string", async () => {
    const db = fakeDb({
      id: "g-1",
      title: "  AURP  ",
      funder: "  AR Ag  ",
      fon: "AURP-2026",
      assistance_listings: [{ number: "10.902" }, { number: "10.903" }],
      submission_deadline: "2026-03-01",
    });
    expect(await loadFocusGrant(db, "g-1")).toEqual({
      id: "g-1",
      title: "AURP",
      funder: "AR Ag",
      cfda: "10.902, 10.903",
      deadline: "2026-03-01",
      fon: "AURP-2026",
    });
  });

  it("nulls empty/absent facts and falls back to 'this grant' for a blank title", async () => {
    const db = fakeDb({
      id: "g-2",
      title: "   ",
      funder: null,
      fon: null,
      assistance_listings: null,
      submission_deadline: null,
    });
    expect(await loadFocusGrant(db, "g-2")).toEqual({
      id: "g-2",
      title: "this grant",
      funder: null,
      cfda: null,
      deadline: null,
      fon: null,
    });
  });

  it("returns null when the grant does not resolve (turn proceeds ungrounded, never a crash)", async () => {
    expect(await loadFocusGrant(fakeDb(null), "missing")).toBeNull();
  });

  it("returns null when the read THROWS — fail-soft on a network throw, never propagates", async () => {
    // A genuine Supabase/network throw (not the ordinary {data,error}) would otherwise escape between
    // appendUser's write and the assistant-row guarantee, orphaning the user turn. The try/catch fails
    // soft to null instead (an ungrounded turn), which is what the loader's contract promises.
    const throwingDb = {
      from: () => {
        const chain = {
          select: () => chain,
          eq: () => chain,
          maybeSingle: async () => {
            throw new Error("network");
          },
        };
        return chain;
      },
    } as unknown as SupabaseClient;
    expect(await loadFocusGrant(throwingDb, "g-1")).toBeNull();
  });
});
