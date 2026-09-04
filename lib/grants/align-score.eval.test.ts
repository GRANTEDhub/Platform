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
  // Identify the grant by EITHER its Simpler opportunity UUID (exact + dupe-proof: matched on
  // source_url, which ingest builds as https://simpler.grants.gov/opportunity/<uuid>) OR a title
  // ilike. Prefer the UUID for ingested Simpler grants; title is the fallback for the pre-existing
  // no-go specimens. Most-recent (ingested_at) wins either way.
  grantUuid?: string;
  grantTitleLike?: string;
  // INLINE-FIXTURE FALLBACK: for a grant that cannot be ingested/shredded to full -- a non-Simpler NOFO
  // (SAMHSA TI-26-015) or a Simpler grant stuck at summary (deep-shred source unfetchable) -- carry the
  // real NOFO facts here instead of a DB lookup. The client is still the REAL DB row; only the grant is
  // hand-built. Fill from the OFFICIAL NOFO; verify awards/deadline/eligibility from source, do not guess.
  grantInline?: Partial<Grant>;
  band: Band;
  // Blank matching_rules before scoring (rule G1): the verdict must come from the profile, not a crutch.
  stripCrutch?: boolean;
}

// Safe defaults so a Partial<Grant> inline fixture never NPEs the scorer's grant/client block builder.
const INLINE_GRANT_SKELETON = {
  id: "inline",
  source_url: null,
  funder: null,
  fon: null,
  title: null,
  description: null,
  ideal_applicant_profile: null,
  award_range_min: null,
  award_range_max: null,
  total_funding: null,
  submission_deadline: null,
  cost_share: null,
  eligible_entity_types: null,
  geographic_eligibility: null,
  ineligible_entities: null,
  focus_areas: null,
  program_type: null,
  subaward_prohibited: null,
  scoring_criteria_high_value: null,
  raw_text: null,
} as unknown as Grant;

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

  // ── KEEP band (must stay >= 2, STRICT every run) -- one real "would-send" match per entity type ─────
  // Named by Shannon's judgment (bar = "real match in SOME role", not "must prime"). Keyed by the Simpler
  // opportunity UUID so the fixture is exact. stripCrutch=true on all (rule G1): a KEEP that only holds
  // because of a hand-written matching_rule isn't proving the scorer -- the profile must carry it.
  // READINESS (drop each once its grant reaches shred_depth='full'):
  //   READY NOW  -- Harbor House x Offender Reentry (full shred, real client_profile).
  //   NEEDS INGEST (POST /api/grants/ingest) -- CCBHC, Strengthening CC, USDA RD, EDA PWEAA, DOT RAISE.
  //   NEEDS RE-SHRED (POST /api/grants/backfill-reshred) -- the transit grant (summary-only today).
  //   CONFIRM -- NWACC's distilled client_profile (name is the acronym "NWACC"); Mississippi County name.
  {
    label: "Harbor House x Offender Reentry (BJA Smart Reentry) -- nonprofit implementer [READY]",
    clientNameLike: "%harbor house%",
    grantUuid: "9e70946c-6830-4c6c-be95-20bcba375534",
    band: "keep",
    stripCrutch: true,
  },
  {
    label: "Arisa Health x CCBHC Improvement & Advancement -- health system [needs ingest]",
    clientNameLike: "%arisa%",
    grantUuid: "0e5c874f-2e12-4e93-a878-7e80d00b3287",
    band: "keep",
    stripCrutch: true,
  },
  {
    label: "NWACC x Strengthening Community Colleges -- community college [needs ingest + confirm profile]",
    clientNameLike: "%nwacc%",
    grantUuid: "c05cfe8d-504c-49b0-84fa-d7b581e0a635",
    band: "keep",
    stripCrutch: true,
  },
  {
    label: "Ozark Regional Transit x ICAM Pilot -- transit authority [needs re-shred]",
    clientNameLike: "%ozark%transit%",
    grantUuid: "9f37fa10-8d49-42f4-81c4-d46fee2768dd",
    band: "keep",
    stripCrutch: true,
  },
  // INLINE FALLBACK if the transit grants stay stuck at summary (deep-shred source unfetchable): drop the
  // real FTA NOFO facts here and delete the UUID fixture above. Same shape works for SAMHSA TI-26-015.
  // Fill <from NOFO> from the official source -- do not guess awards/deadline.
  // {
  //   label: "Ozark Regional Transit x FTA 5310 ICAM (inline) -- transit [summary-stuck fallback]",
  //   clientNameLike: "%ozark%transit%",
  //   band: "keep",
  //   stripCrutch: true,
  //   grantInline: {
  //     title: "Enhanced Mobility of Seniors & Individuals with Disabilities (Section 5310) -- ICAM Pilot",
  //     funder: "Federal Transit Administration (FTA)",
  //     fon: "<from NOFO>",
  //     description: "<paste the NOFO's funded purpose: coordinated access & mobility for seniors and people with disabilities>",
  //     eligible_entity_types: ["States", "Designated recipients", "Local governmental authorities", "Nonprofit organizations"],
  //     geographic_eligibility: "United States",
  //     focus_areas: ["Transit", "Mobility", "Access"],
  //     program_type: "Formula/Discretionary",
  //     submission_deadline: "<from NOFO>",
  //     award_range_min: "<from NOFO>",
  //     award_range_max: "<from NOFO>",
  //   },
  // },
  {
    label: "Mississippi County x USDA Rural Development -- local gov [needs ingest]",
    clientNameLike: "%mississippi county%",
    grantUuid: "e407af15-6c31-41de-80ac-3ffcaf61ea88",
    band: "keep",
    stripCrutch: true,
  },
  {
    label: "Mississippi County x EDA PWEAA -- local gov [needs ingest]",
    clientNameLike: "%mississippi county%",
    grantUuid: "b5365cea-b07c-4e8d-8313-e23ab0fd3766",
    band: "keep",
    stripCrutch: true,
  },
  {
    label: "Mississippi County x DOT BUILD/RAISE -- local gov [needs ingest]",
    clientNameLike: "%mississippi county%",
    grantUuid: "4d8f5775-ff01-4a6f-ab4e-b125899043b3",
    band: "keep",
    stripCrutch: true,
  },

  // ── KEEP-140 anchor (must stay >= 2) -- STILL NEEDED FROM SHANNON, the #140 guard ────────────────────
  // An integrative-fit regional multi-sector org on a broad grant (the class the seat model buried). The
  // GATE test below stays RED until this is supplied -- do NOT flip the flag on a run without it.
  // { label: "<regional multi-sector org> x <broad grant>", clientNameLike: "%...%", grantUuid: "...", band: "keep-140", stripCrutch: true },
];

const RUN = process.env.RUN_ALIGN_SPOTCHECK === "1" && !!process.env.ANTHROPIC_API_KEY;
const RUNS = Math.max(1, parseInt(process.env.ALIGN_SPOTCHECK_RUNS || "3", 10));

async function loadClient(db: ReturnType<typeof createServiceClient>, nameLike: string): Promise<Client | null> {
  const { data } = await db.from("clients").select("*").ilike("name", nameLike).limit(1).maybeSingle<Client>();
  return data ?? null;
}
async function loadGrant(db: ReturnType<typeof createServiceClient>, fx: Fixture): Promise<Grant | null> {
  if (fx.grantInline) return { ...INLINE_GRANT_SKELETON, ...fx.grantInline } as Grant; // hand-built NOFO facts
  let q = db.from("grants").select("*");
  if (fx.grantUuid) q = q.ilike("source_url", `%${fx.grantUuid}%`); // exact: ingest stores .../opportunity/<uuid>
  else if (fx.grantTitleLike) q = q.ilike("title", fx.grantTitleLike);
  else return null;
  const { data } = await q
    // grants has no created_at; ingested_at is the ingest timestamp (most-recent match wins).
    .order("ingested_at", { ascending: false })
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
        const grant = await loadGrant(db, fx);
        expect(client, `client not found for "${fx.clientNameLike}"`).toBeTruthy();
        expect(grant, `grant not found for "${fx.grantUuid ?? fx.grantTitleLike ?? "(inline)"}"`).toBeTruthy();
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
