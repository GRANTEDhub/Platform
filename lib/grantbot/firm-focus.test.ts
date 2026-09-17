import { describe, it, expect } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  loadSurfacedProspects,
  buildFirmFocusBlock,
  MAX_FIRM_FOCUS_PROSPECTS,
  type SurfacedProspect,
} from "./firm-focus";
import type { FocusGrant } from "./focus-grant";

const grant: FocusGrant = {
  id: "g1",
  title: "Recreational Trails Program (RTP)",
  funder: "Arkansas DOT",
  cfda: "20.219",
  deadline: "April 30, 2026",
  fon: "RTP-2026",
};

// ── buildFirmFocusBlock — the grounding block ──────────────────────────────────────────────────────

describe("buildFirmFocusBlock — grant + prospects grounding block", () => {
  it("is a cacheable:false focus-grant block sourced from firm-focus.ts (never busts the cache)", () => {
    const block = buildFirmFocusBlock(grant, []);
    expect(block.cacheable).toBe(false);
    expect(block.kind).toBe("focus-grant");
    expect(block.source).toBe("lib/grantbot/firm-focus.ts");
  });

  it("carries the grant's public facts (title, funder, CFDA, deadline, opportunity number)", () => {
    const t = buildFirmFocusBlock(grant, []).text;
    expect(t).toContain("Recreational Trails Program (RTP)");
    expect(t).toContain("Arkansas DOT");
    expect(t).toContain("20.219");
    expect(t).toContain("April 30, 2026");
    expect(t).toContain("RTP-2026");
  });

  it("degrades to a GRANT-ONLY block with an honest no-prospects note when none are surfaced", () => {
    const t = buildFirmFocusBlock(grant, []).text;
    expect(t).toContain("has NOT surfaced any prospect organizations");
    expect(t).not.toContain("PROSPECTS WE SURFACED FOR THIS GRANT");
  });

  it("renders the surfaced prospects — name, fit, credibility, why bullets, concept", () => {
    const prospects: SurfacedProspect[] = [
      {
        name: "Ozark Trails Council",
        orgType: "nonprofit",
        location: "Washington County, AR",
        fitScore: 3,
        credibility: "Proven",
        why: ["Has built RTP-funded trail before", "Statewide volunteer network"],
        concept: "Construct 5 miles of multi-use trail",
      },
      {
        name: "Small Town Parks Dept",
        orgType: "local_government",
        location: "AR",
        fitScore: 2,
        credibility: "Web-surfaced",
        why: ["Owns the trailhead parcel"],
        concept: null,
      },
    ];
    const t = buildFirmFocusBlock(grant, prospects).text;
    expect(t).toContain("PROSPECTS WE SURFACED FOR THIS GRANT (2)");
    expect(t).toContain("Ozark Trails Council");
    expect(t).toContain("(nonprofit)");
    expect(t).toContain("Washington County, AR");
    expect(t).toContain("fit 3/3");
    expect(t).toContain("Proven");
    expect(t).toContain("Has built RTP-funded trail before");
    expect(t).toContain("Concept: Construct 5 miles");
    expect(t).toContain("Small Town Parks Dept");
    // Prime-vs-partner + estimates discipline is pinned in the block.
    expect(t).toContain("prime");
  });
});

// ── loadSurfacedProspects — the review_cards+prospects loader ───────────────────────────────────────

// A chainable fake of: db.from("review_cards").select(..).eq(..).eq(..).order(..).limit(..) → { data }.
function fakeDb(rows: unknown[]): SupabaseClient {
  const q: Record<string, unknown> = {};
  const chain = () => q;
  q.select = chain;
  q.eq = chain;
  q.order = chain;
  q.limit = chain;
  (q as { then: unknown }).then = (resolve: (v: { data: unknown[]; error: null }) => void) =>
    resolve({ data: rows, error: null });
  return { from: () => q } as unknown as SupabaseClient;
}

function throwingDb(): SupabaseClient {
  return {
    from: () => ({
      select: () => {
        throw new Error("network down");
      },
    }),
  } as unknown as SupabaseClient;
}

describe("loadSurfacedProspects — flattens review_cards+prospects, fail-soft", () => {
  it("maps a joined row: name, org type, county+state location, fit, credibility, why, concept", async () => {
    const db = fakeDb([
      {
        fit_score: 3,
        why_this_org: ["Won this program before", "  ", "Local footprint"],
        concept_synopsis: "Build trail",
        prospects: {
          name: "Ozark Trails Council",
          org_type: "nonprofit",
          location_state: "AR",
          location_county: "Washington County",
          source_url: "https://www.usaspending.gov/award/123",
          capability_summary: "Trail builder",
        },
      },
    ]);
    const [p] = await loadSurfacedProspects(db, "g1");
    expect(p.name).toBe("Ozark Trails Council");
    expect(p.orgType).toBe("nonprofit");
    expect(p.location).toBe("Washington County, AR");
    expect(p.fitScore).toBe(3);
    expect(p.credibility).toBe("Proven"); // usaspending.gov → proven tier
    expect(p.why).toEqual(["Won this program before", "Local footprint"]); // blank bullet dropped
    expect(p.concept).toBe("Build trail");
  });

  it("normalizes an array-embedded prospect and formats a state-only location", async () => {
    const db = fakeDb([
      {
        fit_score: 2,
        why_this_org: null,
        concept_synopsis: null,
        prospects: [{ name: "State Parks", org_type: null, location_state: "AR", location_county: null, source_url: "https://x.org", capability_summary: null }],
      },
    ]);
    const [p] = await loadSurfacedProspects(db, "g1");
    expect(p.name).toBe("State Parks");
    expect(p.location).toBe("AR");
    expect(p.credibility).toBe("Web-surfaced");
    expect(p.why).toEqual([]);
  });

  it("drops a row whose prospect embed is null or nameless (no ghost entries)", async () => {
    const db = fakeDb([
      { fit_score: 1, why_this_org: [], concept_synopsis: null, prospects: null },
      { fit_score: 1, why_this_org: [], concept_synopsis: null, prospects: { name: "   " } },
    ]);
    expect(await loadSurfacedProspects(db, "g1")).toEqual([]);
  });

  it("clamps to MAX_WHY_BULLETS (4) why bullets per prospect", async () => {
    const db = fakeDb([
      {
        fit_score: 3,
        why_this_org: ["a", "b", "c", "d", "e", "f"],
        concept_synopsis: null,
        prospects: { name: "Org", org_type: null, location_state: null, location_county: null, source_url: "https://x", capability_summary: null },
      },
    ]);
    const [p] = await loadSurfacedProspects(db, "g1");
    expect(p.why).toHaveLength(4);
  });

  it("fails soft to [] on a thrown read (never crashes the turn)", async () => {
    expect(await loadSurfacedProspects(throwingDb(), "g1")).toEqual([]);
  });

  it("MAX_FIRM_FOCUS_PROSPECTS is a sane cap", () => {
    expect(MAX_FIRM_FOCUS_PROSPECTS).toBeGreaterThan(0);
    expect(MAX_FIRM_FOCUS_PROSPECTS).toBeLessThanOrEqual(50);
  });
});
