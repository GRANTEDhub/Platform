import { describe, it, expect, beforeAll } from "vitest";
import { createServiceClient } from "@/lib/supabase/server";
import { alignScoreClient } from "@/lib/grants/align-score";
import { formatStoredUSASpending } from "@/lib/grants/usaspending";
import type { Client, Grant } from "@/types/database";

// ── Direct-alignment scorer spot-check (MATCH_DIRECT_ALIGN_ENABLED) ──────────────────────────────────
//
// MODEL-IN-THE-LOOP. NOT a unit test; MUST NOT run in the normal suite or the sandbox -- it makes real
// Anthropic calls (the scorer) and reads prod client/grant rows. Skipped unless RUN_ALIGN_SPOTCHECK=1 AND
// ANTHROPIC_API_KEY is present; it also needs the Supabase service-role env. Trigger it in preview/CI or a
// shell carrying all three:
//
//   RUN_ALIGN_SPOTCHECK=1 ALIGN_SPOTCHECK_RUNS=3 \
//   ANTHROPIC_API_KEY=... NEXT_PUBLIC_SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... \
//   npx vitest run lib/grants/align-score.eval.test.ts
//
// This is the GATE the flag flip depends on. It is NOT a labeling corpus -- it is a ~15-pair adversarial
// spot-check that validates the REASONING (does it ask the right question), with three bands:
//   NO-GO   -- entity-eligible-but-functionally-wrong matches that MUST drop to a Pass (fit <= 1). The
//             cheaper-error direction, so asserted on the MAJORITY of runs (temp-0 still flickers).
//             AGFF fixtures STRIP matching_rules first (rule G1) -- the no-go must be earned from the
//             profile's can_prime=false, NOT the hand-written crutch we are replacing.
//   KEEP    -- real matches you would stake your name on, one per entity type, that MUST stay >= 2.
//             STRICT (every run): over-killing a good match is the expensive error.
//   KEEP-140 -- the #140 anchor: integrative-fit regional multi-sector orgs on a broad grant that MUST
//             stay >= 2. STRICT. This is the specific guard against repeating the incident the seat model
//             existed to prevent; a simple-alignment model reintroduces #140 ONLY if it scores
//             competitiveness, so this band is non-negotiable before the flip.
//
// The KEEP / KEEP-140 bands are intentionally EMPTY here -- Shannon supplies those pairs. The gate test
// below FAILS until they are populated, so a green run genuinely means "safe to flip".

type Band = "no-go" | "keep" | "keep-140";

interface Fixture {
  label: string;
  clientNameLike: string; // ilike on clients.name
  grantTitleLike: string; // ilike on grants.title (most-recent match wins)
  band: Band;
  // Blank matching_rules before scoring (rule G1): the verdict must come from the profile, not a crutch.
  stripCrutch?: boolean;
}

const FIXTURES: Fixture[] = [
  // ── NO-GO band (confirmed specimens; must drop to a Pass) ──────────────────────────────────────────
  // AGFF is a fundraising / fiscal-sponsor foundation (client_profile.prime_capacity.can_prime=false).
  // Strip its matching_rules so the no-go is earned from the profile alone (rule G1).
  {
    label: "AGFF x BLM Threatened & Endangered Species (funder, not field implementer)",
    clientNameLike: "%game and fish foundation%",
    grantTitleLike: "%Threatened and Endangered Species%",
    band: "no-go",
    stripCrutch: true,
  },
  {
    label: "AGFF x NAWCA Wetlands (funder, not implementer)",
    clientNameLike: "%game and fish foundation%",
    grantTitleLike: "%NAWCA%",
    band: "no-go",
    stripCrutch: true,
  },
  {
    label: "AGFF x National Fish Passage (funder, not implementer)",
    clientNameLike: "%game and fish foundation%",
    grantTitleLike: "%National Fish Passage%",
    band: "no-go",
    stripCrutch: true,
  },
  {
    label: "GreenLab x Emergency Citrus Disease Research (wrong activity)",
    clientNameLike: "%greenlab%",
    grantTitleLike: "%Emergency Citrus Disease%",
    band: "no-go",
  },
  {
    label: "GreenLab x DOE ASPECT chemical scale-up (wrong activity)",
    clientNameLike: "%greenlab%",
    grantTitleLike: "%ASPECT%",
    band: "no-go",
  },

  // ── KEEP band (must stay >= 2) -- SHANNON SUPPLIES, one per entity type ─────────────────────────────
  // A real match you would send, per entity type (county / nonprofit implementer / community college /
  // health system / transit authority). Uncomment and fill clientNameLike + grantTitleLike:
  // { label: "County <X> x <real county grant>", clientNameLike: "%...%", grantTitleLike: "%...%", band: "keep" },
  // { label: "<nonprofit implementer> x <real fit>", clientNameLike: "%...%", grantTitleLike: "%...%", band: "keep" },
  // { label: "<community college> x <real fit>", clientNameLike: "%...%", grantTitleLike: "%...%", band: "keep" },
  // { label: "<health system> x <real fit>", clientNameLike: "%...%", grantTitleLike: "%...%", band: "keep" },
  // { label: "<transit authority> x <real fit>", clientNameLike: "%...%", grantTitleLike: "%...%", band: "keep" },

  // ── KEEP-140 anchor (must stay >= 2) -- SHANNON SUPPLIES, the #140 guard ────────────────────────────
  // An integrative-fit regional multi-sector org on a broad grant (the class the seat model buried).
  // { label: "<regional multi-sector org> x <broad grant>", clientNameLike: "%...%", grantTitleLike: "%...%", band: "keep-140" },
];

const RUN = process.env.RUN_ALIGN_SPOTCHECK === "1" && !!process.env.ANTHROPIC_API_KEY;
const RUNS = Math.max(1, parseInt(process.env.ALIGN_SPOTCHECK_RUNS || "3", 10));

async function loadClient(db: ReturnType<typeof createServiceClient>, nameLike: string): Promise<Client | null> {
  const { data } = await db.from("clients").select("*").ilike("name", nameLike).limit(1).maybeSingle<Client>();
  return data ?? null;
}
async function loadGrant(db: ReturnType<typeof createServiceClient>, titleLike: string): Promise<Grant | null> {
  const { data } = await db
    .from("grants")
    .select("*")
    .ilike("title", titleLike)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle<Grant>();
  return data ?? null;
}

(RUN ? describe : describe.skip)("direct-alignment scorer spot-check (model-in-the-loop)", () => {
  // Lazy: created in beforeAll so a SKIPPED run (no creds in the sandbox) never calls createServiceClient()
  // at collection time. beforeAll bodies do not execute inside a skipped describe.
  let db: ReturnType<typeof createServiceClient>;
  beforeAll(() => {
    db = createServiceClient();
  });

  // The flip gate: KEEP + KEEP-140 anchors MUST exist, or a green no-go run is a false green. This test
  // FAILS until Shannon supplies them -- do not flip MATCH_DIRECT_ALIGN_ENABLED on a run where it is red.
  it("GATE: the KEEP and KEEP-140 anchor bands are populated before trusting a green run", () => {
    const keep = FIXTURES.filter((f) => f.band === "keep").length;
    const keep140 = FIXTURES.filter((f) => f.band === "keep-140").length;
    expect(
      keep,
      "Add real 'must stay >= 2' matches (one per entity type) to FIXTURES before the flip.",
    ).toBeGreaterThan(0);
    expect(
      keep140,
      "Add at least one integrative-fit regional org (#140 anchor) to FIXTURES before the flip.",
    ).toBeGreaterThan(0);
  });

  for (const fx of FIXTURES) {
    it(
      `[${fx.band}] ${fx.label}`,
      async () => {
        const client = await loadClient(db, fx.clientNameLike);
        const grant = await loadGrant(db, fx.grantTitleLike);
        expect(client, `client not found for "${fx.clientNameLike}"`).toBeTruthy();
        expect(grant, `grant not found for "${fx.grantTitleLike}"`).toBeTruthy();
        if (!client || !grant) return;

        // Rule G1: strip the hand-written matching_rules crutch so the verdict is earned from the profile.
        const scored: Client = fx.stripCrutch ? ({ ...client, matching_rules: null } as Client) : client;
        const usa = scored.federal_history_verified
          ? undefined
          : formatStoredUSASpending(scored.usaspending_summary);

        const scores: number[] = [];
        for (let i = 0; i < RUNS; i++) {
          const res = await alignScoreClient(grant, scored, usa);
          scores.push(res.fit_score);
        }

        if (fx.band === "no-go") {
          // Majority of runs must Pass it (fit <= 1). Cheaper-error direction; temp-0 still flickers.
          const passes = scores.filter((s) => s <= 1).length;
          expect
            .soft(passes, `expected majority no-go, got scores [${scores.join(", ")}]`)
            .toBeGreaterThan(RUNS / 2);
        } else {
          // KEEP / KEEP-140: STRICT -- every run must stay surfaced (fit >= 2). Over-killing a good match
          // (or repeating #140 on the integrative-fit anchor) is the expensive error.
          const kept = scores.every((s) => s >= 2);
          expect.soft(kept, `expected all runs >= 2 (must stay), got scores [${scores.join(", ")}]`).toBe(true);
        }
      },
      120_000,
    );
  }
});
