import { describe, it, expect, beforeAll } from "vitest";
import { createServiceClient } from "@/lib/supabase/server";
import { matchGrantToClient } from "@/lib/grants/engine";
import { formatStoredUSASpending } from "@/lib/grants/usaspending";
import { evaluateGenericNexus } from "@/lib/grants/generic-nexus";
import type { Client, Grant } from "@/types/database";

// ── Fix #6 eval: generic-over-specific demote tag (MATCH_GENERIC_NEXUS_GATE_ENABLED) ────────────
//
// MODEL-IN-THE-LOOP. NOT a unit test; MUST NOT run in the normal suite or the sandbox — it makes real
// Anthropic calls (scoring + the scoped nexus classifier) and reads prod grant/client rows. Skipped
// unless RUN_GENERIC_NEXUS_EVAL=1 AND ANTHROPIC_API_KEY is present; it also needs the Supabase
// service-role env. Trigger it in preview/CI or a shell carrying all three:
//
//   RUN_GENERIC_NEXUS_EVAL=1 GENERIC_NEXUS_EVAL_RUNS=3 \
//   ANTHROPIC_API_KEY=... NEXT_PUBLIC_SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... \
//   npx vitest run lib/grants/generic-nexus.eval.test.ts
//
// This is the GATE the flag flip depends on. It sets the classifier flag ON, scores each fixture RUNS
// times, runs evaluateGenericNexus on each result, and asserts per band:
//   FLAG band   — a genuine generic-over-specific pair (the qualifying dimension is inferred from
//                 thematic adjacency). Must seat at a conditional 2 AND flag on EVERY run (stability).
//   KEEP band   — a legitimate execution-conditional 2 (dimension entailed by the org's confirmed
//                 identity; caps are MOU / past-performance / SAM / budget). Must NEVER flag.
//   MIDDLE band — the fuzzy near-structural case (county "assumed to operate a jail"). The prompt is
//                 biased to UNDER-flag here; must NOT flag. If it does, strengthen the entailed bias.
//
// Rows are resolved by ilike (client name + a DISTINCTIVE grant-title fragment) rather than pinned ids,
// because the sandbox that authored this file cannot SELECT prod ids. Each resolver asserts EXACTLY one
// match (throws on 0 or >1) so an ambiguous fragment fails loud rather than testing the wrong grant. If
// a title re-normalizes and a fragment stops matching, pin that fixture to grants.id instead.

const RUN = process.env.RUN_GENERIC_NEXUS_EVAL === "1" && !!process.env.ANTHROPIC_API_KEY;

const intEnv = (raw: string | undefined, def: number) => {
  const n = raw?.trim() ? Number(raw) : NaN;
  return Math.max(1, Number.isFinite(n) && n > 0 ? Math.floor(n) : def);
};
const RUNS = intEnv(process.env.GENERIC_NEXUS_EVAL_RUNS, 3);
const CONCURRENCY = intEnv(process.env.GENERIC_NEXUS_EVAL_CONCURRENCY, 6);
const FLAG = "MATCH_GENERIC_NEXUS_GATE_ENABLED";

async function mapCapped<T, R>(items: T[], cap: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = await fn(items[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(cap, items.length) }, worker));
  return out;
}

type Band = "flag" | "keep" | "middle";
interface Fixture {
  label: string;
  client: string; // ilike against clients.name
  grantFragment: string; // DISTINCTIVE ilike fragment against grants.title (must match exactly one row)
  band: Band;
}

// The seated-at-2 rows read in the diagnosis. FLAG = qualifying dimension inferred from adjacency;
// KEEP = dimension entailed by confirmed identity (execution-only caps); MIDDLE = near-structural fuzzy.
const FIXTURES: Fixture[] = [
  {
    label: "FLAG — NWACC × Reentry Education (correctional-education nexus inferred from workforce mission)",
    client: "NWACC",
    grantFragment: "Improving Reentry Education",
    band: "flag",
  },
  {
    label: "FLAG — Arisa × Family-Based SUD (justice-involved population inferred from SUD service model)",
    client: "Arisa Health",
    grantFragment: "Family-Based Substance Use Disorder",
    band: "flag",
  },
  {
    label: "FLAG — Arisa × Kevin & Avonte (dementia caseload inferred from behavioral-health scope)",
    client: "Arisa Health",
    grantFragment: "Kevin and Avonte",
    band: "flag",
  },
  {
    label: "KEEP — Arisa × MAT-Opioid (SUD function confirmed; cap is past-performance only)",
    client: "Arisa Health",
    grantFragment: "Medication-Assisted Treatment - Prescription Drug and Opioid",
    band: "keep",
  },
  {
    label: "KEEP — Columbia County × Body-Worn Camera (law-enforcement identity confirmed; new program instance)",
    client: "Columbia County",
    grantFragment: "Body-Worn Camera Policy and Implementation",
    band: "keep",
  },
  {
    label: "KEEP — Faulkner County × Body-Worn Camera (law-enforcement identity confirmed; execution caps)",
    client: "Faulkner County",
    grantFragment: "Body-Worn Camera Policy and Implementation",
    band: "keep",
  },
  {
    label: "MIDDLE — Faulkner County × Sexual Assaults in Confinement (near-structural: county 'assumed to operate a jail')",
    client: "Faulkner County",
    grantFragment: "Investigating and Prosecuting Sexual Assaults",
    band: "middle",
  },
];

interface Read {
  fit: number;
  seat: string | null;
  disq: boolean;
  supp: boolean;
  flagged: boolean;
  dimension: string | null; // captured from the flag note for diagnosis
  derivation: string | null;
}

interface Prepared {
  fx: Fixture;
  grant: Grant;
  client: Client;
  ctx: string | undefined;
}

async function scoreAndClassify(p: Prepared): Promise<Read> {
  const match = await matchGrantToClient(p.grant, p.client, p.ctx);
  const nexus = await evaluateGenericNexus(match, p.client, p.grant);
  return {
    fit: match.fit_score,
    seat: match.seat_ref ?? null,
    disq: !!match.disqualified,
    supp: !!match.suppressed,
    flagged: nexus.flagged,
    dimension: nexus.note,
    derivation: match.reasoning_context?.fit_score_derivation ?? null,
  };
}

const SCORING_WAVES = Math.ceil((FIXTURES.length * RUNS) / CONCURRENCY);
const BEFORE_ALL_TIMEOUT_MS = Math.min(55 * 60_000, Math.max(10 * 60_000, SCORING_WAVES * 90_000));

describe.skipIf(!RUN)("generic-nexus eval (model-in-the-loop)", () => {
  const RESULTS = new Map<Fixture, Read[]>();

  beforeAll(async () => {
    const db = createServiceClient();

    // Resolve + prepare every fixture once. The flag is ON for the whole phase (the classifier only
    // fires under it); scoring is unaffected by it, so ON is the only phase we need.
    const prev = process.env[FLAG];
    process.env[FLAG] = "true";

    const prepared: Prepared[] = [];
    for (const fx of FIXTURES) {
      const { data: client } = await db
        .from("clients")
        .select("*")
        .ilike("name", `%${fx.client}%`)
        .limit(2);
      if (!client || client.length !== 1) {
        throw new Error(`[fixture ${fx.label}] client ilike "%${fx.client}%" matched ${client?.length ?? 0} rows (need exactly 1)`);
      }
      const { data: grant } = await db
        .from("grants")
        .select("*")
        .ilike("title", `%${fx.grantFragment}%`)
        .limit(2);
      if (!grant || grant.length !== 1) {
        throw new Error(`[fixture ${fx.label}] grant ilike "%${fx.grantFragment}%" matched ${grant?.length ?? 0} rows (need exactly 1)`);
      }
      const c = client[0] as Client;
      const g = grant[0] as Grant;
      const ctx = c.federal_history_verified ? undefined : formatStoredUSASpending(c.usaspending_summary);
      prepared.push({ fx, grant: g, client: c, ctx });
    }

    const tasks = prepared.flatMap((p) => Array.from({ length: RUNS }, () => p));
    const reads = await mapCapped(tasks, CONCURRENCY, scoreAndClassify);
    prepared.forEach((p, i) => RESULTS.set(p.fx, reads.slice(i * RUNS, i * RUNS + RUNS)));

    if (prev === undefined) delete process.env[FLAG];
    else process.env[FLAG] = prev;
  }, BEFORE_ALL_TIMEOUT_MS);

  it("FLAG band: seats at a conditional 2 and flags on EVERY run (the generic-over-specific catch)", () => {
    for (const fx of FIXTURES.filter((f) => f.band === "flag")) {
      const reads = RESULTS.get(fx)!;
      // Diagnostic dump so a failure shows WHY (drifted off 2, or seated-2-but-not-flagged).
      const summary = reads.map((r) => `fit=${r.fit} seat=${r.seat} flagged=${r.flagged}`).join(" | ");
      expect(reads.every((r) => r.fit === 2 && !r.disq && !r.supp), `${fx.label} must seat at conditional 2 :: ${summary}`).toBe(true);
      expect(reads.every((r) => r.flagged), `${fx.label} must flag on every run :: ${summary}`).toBe(true);
    }
  });

  it("KEEP band: a legitimate execution-conditional 2 is NEVER flagged (no over-fire)", () => {
    for (const fx of FIXTURES.filter((f) => f.band === "keep")) {
      const reads = RESULTS.get(fx)!;
      const summary = reads.map((r) => `fit=${r.fit} seat=${r.seat} flagged=${r.flagged}`).join(" | ");
      expect(reads.every((r) => !r.flagged), `${fx.label} must NOT flag :: ${summary}`).toBe(true);
    }
  });

  it("MIDDLE band: the near-structural fuzzy case leans entailed and does NOT flag (under-flag bias)", () => {
    for (const fx of FIXTURES.filter((f) => f.band === "middle")) {
      const reads = RESULTS.get(fx)!;
      const summary = reads.map((r) => `fit=${r.fit} seat=${r.seat} flagged=${r.flagged}`).join(" | ");
      expect(reads.every((r) => !r.flagged), `${fx.label} must lean entailed (not flag) :: ${summary}`).toBe(true);
    }
  });
});
