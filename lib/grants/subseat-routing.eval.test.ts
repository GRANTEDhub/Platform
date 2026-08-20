import { describe, it, expect, beforeAll } from "vitest";
import { createServiceClient } from "@/lib/supabase/server";
import { matchGrantToClient } from "@/lib/grants/engine";
import { formatStoredUSASpending } from "@/lib/grants/usaspending";
import { seatFamily } from "@/lib/grants/calibration";
import type { Client, Grant } from "@/types/database";

// ── Phase 1a eval: supporting-seat routing (MATCH_SUBSEAT_ROUTING_ENABLED) ──────────────────
//
// MODEL-IN-THE-LOOP. This is NOT a unit test and MUST NOT run in the normal suite or the
// sandbox: it makes real Anthropic calls (scoring) and reads prod grant/client rows. It is
// skipped unless RUN_SUBSEAT_EVAL=1 AND an ANTHROPIC_API_KEY is present, and it needs the
// Supabase service-role env too. Trigger it in preview/CI or a shell that carries all three:
//
//   RUN_SUBSEAT_EVAL=1 SUBSEAT_EVAL_RUNS=3 \
//   ANTHROPIC_API_KEY=... NEXT_PUBLIC_SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... \
//   npx vitest run lib/grants/subseat-routing.eval.test.ts
//
// It runs each fixture RUNS times with the flag OFF and RUNS times ON, and asserts:
//   MISS set — ON must SURFACE the specialist as a supporting seat (seat family "supporting",
//     fit_score 2, proposed_role Sub/Co-Applicant, not disqualified/suppressed), OFF must NOT
//     (proving the addendum, not luck, did it), and every ON run must AGREE (stability, not one
//     lucky pass).
//   HIT set — ON must be INDISTINGUISHABLE from OFF on the deciding fields (seat family, EXACT
//     fit_score, disqualified, suppressed, role) — the zero-regression bar. Guards against the
//     flood failure mode (surfacing sub-fits for orgs that should stay out) AND against a silent
//     suppression flip that hides an already-good match.
//   CARVE-OUT set — a single DEFER-FIRST trigger (for-profit org_type, subaward_prohibited=true,
//     or an authoritative suppress rule) applied to the MISS base (PTF / Smart Reentry, the case
//     ON most wants to route to Sub). The addendum must DEFER: ON must NEVER route it to a Sub
//     seat, and a suppressed match must STAY suppressed. Proves the carve-outs actually fire.
//
// KNOWN LIMITATION (documented, not hidden): the miss set is Pathway-to-Freedom-concentrated —
// PTF is the only clean client-side example (Harbor House self-suppresses via its capital-only
// matching rule; NW Arkansas Land Trust is not a client). If a second clean non-PTF sub-only
// case appears in the roster, add it here.

const RUN = process.env.RUN_SUBSEAT_EVAL === "1" && !!process.env.ANTHROPIC_API_KEY;
const RUNS = Math.max(1, Number(process.env.SUBSEAT_EVAL_RUNS ?? 3));
// Max concurrent scoring calls within a single flag phase. Batching by flag (below) lets every
// (fixture × run) call in a phase run at once; this caps the fan-out so a burst doesn't trip
// Anthropic rate limits. Lower it if you see 429s; raise it if your tier allows.
const CONCURRENCY = Math.max(1, Number(process.env.SUBSEAT_EVAL_CONCURRENCY ?? 6));
const FLAG = "MATCH_SUBSEAT_ROUTING_ENABLED";

// Concurrency-capped map: at most `cap` promises from `fn` are in flight at once. Order preserved.
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

type Band = "miss" | "hit" | "carveout";
interface Fixture {
  label: string;
  client: string; // ilike against clients.name
  grantId: string; // pinned to grants.id (stable; NOFO titles can re-normalize on re-ingest)
  band: Band;
  // CARVE-OUT only: apply the ONE DEFER-FIRST trigger to a confirmed-real base pair, in place,
  // after load and before scoring. Isolates the carve-out — everything else stays identical to a
  // case the addendum WOULD route to Sub, so a pass proves the DEFER-FIRST block (not the data) did it.
  mutate?: (rows: { client: Client; grant: Grant }) => void;
  expectSuppressed?: boolean; // carve-out: also assert ON stays suppressed (never un-suppressed)
}

// Miss = should START surfacing as a sub. Hit = must NOT change (correct today). Carve-out = a
// DEFER-FIRST trigger applied to the miss base (PTF / Smart Reentry, the case ON most wants to
// route to Sub) — the addendum must DEFER and NOT route it to Sub.
// Grant ids are pinned to real, profiled prod rows (Platform, gpqrzvnhxjsqerfczhqt), confirmed
// to carry an ideal_applicant_profile — the occupancy step is meaningless without one.
const G_SMART_REENTRY = "652cab62-5180-43e5-8ac8-9340af696ac4"; // BJA FY2026 Smart Reentry Demonstration
const G_PSMHI = "293c7a5e-8f27-4037-809e-247e76518989"; // BJA FY2026 Public Safety and Mental Health Initiative
const G_REENTRY_ED = "4335a5d5-611c-4258-b70f-52e8b494fe30"; // BJA FY2026 Second Chance Act Improving Reentry Education
const G_WATER_WORKFORCE = "43827e63-a945-4004-b56c-578013cd0ad2"; // Innovative Water Infrastructure Workforce Development

const FIXTURES: Fixture[] = [
  { label: "PTF / Smart Reentry (gov-only; PTF fills the reentry-provider sub-seat)", client: "Pathway to Freedom", grantId: G_SMART_REENTRY, band: "miss" },
  { label: "PTF / Public Safety & Mental Health (gov-only sub)", client: "Pathway to Freedom", grantId: G_PSMHI, band: "miss" },
  { label: "PTF / SC Reentry Education (broad eligibility — genuine match, must stay)", client: "Pathway to Freedom", grantId: G_REENTRY_ED, band: "hit" },
  { label: "Arisa / Water Infrastructure Workforce (correct zero — wrong sector)", client: "Arisa Health", grantId: G_WATER_WORKFORCE, band: "hit" },
  // NOTE: the second Arisa "correct zero" (Rural Housing Preservation, f6e9bd59-b02b-415d-a03b-37da22314927)
  // is intentionally omitted — that grant has NO ideal_applicant_profile in prod, so it can't run through
  // the occupancy step and is not a valid fixture. Arisa's zero-regression coverage rests on the Water
  // Infrastructure hit above; re-add a second profiled "correct zero" for Arisa when one exists.
  // ── DEFER-FIRST carve-outs (all on the PTF / Smart Reentry base) ────────────────────────────
  {
    label: "CARVE-OUT for-profit: PTF re-typed for-profit — HARD ROLE RULE (Facilitator only) wins, never Sub",
    client: "Pathway to Freedom",
    grantId: G_SMART_REENTRY,
    band: "carveout",
    mutate: ({ client }) => {
      client.org_type = "For-Profit / Commercial";
    },
  },
  {
    label: "CARVE-OUT subaward-prohibited: same grant flagged subaward_prohibited — Facilitator collapse wins, never Sub",
    client: "Pathway to Freedom",
    grantId: G_SMART_REENTRY,
    band: "carveout",
    mutate: ({ grant }) => {
      grant.subaward_prohibited = true;
    },
  },
  {
    // Suppression is model-produced on this branch (no code path sets suppressed inside
    // matchGrantToClient — every hard-no is the model's), so the deterministic trigger is an
    // AUTHORITATIVE self-suppress matching rule, the same shape Harbor House uses in prod.
    label: "CARVE-OUT suppressed: an authoritative suppress rule on the client — stays suppressed, never Sub",
    client: "Pathway to Freedom",
    grantId: G_SMART_REENTRY,
    band: "carveout",
    expectSuppressed: true,
    mutate: ({ client }) => {
      client.matching_rules = `${client.matching_rules ?? ""}\nSUPPRESS: this organization is pausing ALL reentry-services pursuits this cycle. Do not surface any reentry grant — set suppressed=true and do not score.`.trim();
    },
  },
];

interface Read {
  seatFam: "prime" | "supporting" | "none";
  seat_ref: string | null;
  fit: number;
  role: string | null;
  disq: boolean;
  supp: boolean;
}

function read(m: {
  seat_ref?: string | null;
  fit_score: number;
  proposed_role?: string | null;
  disqualified?: boolean;
  suppressed?: boolean;
}): Read {
  return {
    seatFam: seatFamily(m.seat_ref),
    seat_ref: m.seat_ref ?? null,
    fit: m.fit_score,
    role: m.proposed_role ?? null,
    disq: !!m.disqualified,
    supp: !!m.suppressed,
  };
}

// A loaded, mutation-applied fixture ready to score.
interface Prepared {
  fx: Fixture;
  grant: Grant;
  client: Client;
  ctx: string | undefined;
}

// Score EVERY prepared fixture RUNS times under ONE flag state. The flag is a process-global env
// var, so we set it once for the whole phase and fire all (fixture × run) calls concurrently
// (capped) — no per-call toggle, so nothing races on the global. Each phase is fully awaited
// before the caller flips the flag, so OFF and ON never overlap. Returns reads grouped per fixture.
async function scorePhase(prepared: Prepared[], on: boolean): Promise<Map<Fixture, Read[]>> {
  const prev = process.env[FLAG];
  process.env[FLAG] = on ? "true" : "";
  try {
    const tasks = prepared.flatMap((p) => Array.from({ length: RUNS }, () => p));
    const reads = await mapCapped(tasks, CONCURRENCY, async (p) =>
      read(await matchGrantToClient(p.grant, p.client, p.ctx)),
    );
    const byFixture = new Map<Fixture, Read[]>();
    prepared.forEach((p, i) => byFixture.set(p.fx, reads.slice(i * RUNS, i * RUNS + RUNS)));
    return byFixture;
  } finally {
    if (prev === undefined) delete process.env[FLAG];
    else process.env[FLAG] = prev;
  }
}

// A run is "surfaced as a sub" iff it is a supporting seat at 2 with a Sub/Co-Applicant role and
// no hard gate — the exact target of the addendum.
const isSubSurfaced = (r: Read) =>
  r.seatFam === "supporting" &&
  r.fit === 2 &&
  !r.disq &&
  !r.supp &&
  /sub|co-applicant/i.test(r.role ?? "");

describe.skipIf(!RUN)("subseat-routing eval (model-in-the-loop)", () => {
  // All model calls happen ONCE, here, batched by flag with capped concurrency — not per test.
  // The it() cases below are then pure synchronous assertions over the collected reads, so a slow
  // model call can never trip a per-test timeout (the old failure mode: 6 sequential calls > 180s).
  const RESULTS = new Map<Fixture, { off: Read[]; on: Read[] }>();

  beforeAll(async () => {
    // Created here, not at module top: describe.skipIf still runs this callback's file during
    // collection, so a top-level createServiceClient() would fire (and throw on missing Supabase
    // env) even in a skipped/sandbox run. Guarded by skipIf(!RUN), beforeAll only runs for real.
    const db = createServiceClient();

    // Load + mutate every fixture once (cheap sequential reads), before any scoring.
    const prepared: Prepared[] = [];
    for (const fx of FIXTURES) {
      const { data: client, error: clientErr } = await db
        .from("clients")
        .select("*")
        .ilike("name", fx.client)
        .limit(1)
        .maybeSingle<Client>();
      // Pinned by id (unique) so there is no ordering to get wrong — an earlier `.order("created_at")`
      // hit a non-existent column, 400'd, and the discarded error masqueraded as "grant not found".
      // The profile filter stays as a guard; grantErr is asserted so a schema drift can't hide as one.
      const { data: grant, error: grantErr } = await db
        .from("grants")
        .select("*")
        .eq("id", fx.grantId)
        .not("ideal_applicant_profile", "is", null)
        .maybeSingle<Grant>();

      expect(clientErr, `client query errored: ${clientErr?.message}`).toBeFalsy();
      expect(grantErr, `grant query errored: ${grantErr?.message}`).toBeFalsy();
      expect(client, `client not found: ${fx.client}`).toBeTruthy();
      expect(grant, `grant not found (or no profile): ${fx.grantId}`).toBeTruthy();
      if (!client || !grant) throw new Error(`fixture setup failed: ${fx.label}`);

      // Carve-out: apply the single DEFER-FIRST trigger in place ONCE, so both the OFF and ON
      // phases score the same mutated base and the only variable is the flag.
      if (fx.mutate) fx.mutate({ client, grant });
      const ctx = client.federal_history_verified
        ? undefined
        : formatStoredUSASpending(client.usaspending_summary);
      prepared.push({ fx, grant, client, ctx });
    }

    // Two flag phases, each fully awaited before the next — OFF and ON never overlap on the global.
    const off = await scorePhase(prepared, false);
    const on = await scorePhase(prepared, true);

    // Surface each fixture's rows (helps read the report even on a pass). supp is shown because a
    // suppression flip is a HIT/carve-out regression the seat/fit/role columns alone hide.
    const fmt = (r: Read) => `${r.seat_ref}/${r.fit}/${r.role}${r.disq ? "/DISQ" : ""}${r.supp ? "/SUPP" : ""}`;
    for (const p of prepared) {
      const o = off.get(p.fx)!;
      const n = on.get(p.fx)!;
      RESULTS.set(p.fx, { off: o, on: n });
      console.log(`[${p.fx.band}] ${p.fx.label}\n  OFF: ${o.map(fmt).join(" | ")}\n  ON : ${n.map(fmt).join(" | ")}`);
    }
    // Generous ceiling for all scoring: with concurrency this is a few minutes, but throttling can
    // stretch it. Well under the workflow's 60-min job cap.
  }, 30 * 60_000);

  it.each(FIXTURES)("$label", (fx) => {
    const res = RESULTS.get(fx);
    expect(res, `no scoring result recorded for ${fx.label}`).toBeTruthy();
    if (!res) return;
    const { off, on } = res;

    if (fx.band === "miss") {
      // ON surfaces the sub on EVERY run (stability); NO OFF run surfaces it (proves the addendum,
      // not model variance, is the cause — .some, not .every, or a flaky baseline would pass).
      expect(on.every(isSubSurfaced), "ON should surface a supporting seat on every run").toBe(true);
      expect(off.some(isSubSurfaced), "NO OFF run should surface it (proves the addendum caused it)").toBe(false);
    } else if (fx.band === "carveout") {
      // DEFER-FIRST: the addendum must NOT route this to a supporting Sub seat on ANY run — the
      // for-profit / subaward-prohibited / suppressed triggers all take precedence over the routing.
      expect(on.some(isSubSurfaced), "carve-out: ON must NEVER route this to a supporting Sub seat").toBe(false);
      if (fx.expectSuppressed) {
        // And a suppressed match must STAY suppressed — the addendum may never un-suppress.
        expect(on.every((r) => r.supp), "carve-out: a suppressed match must stay suppressed under the addendum").toBe(true);
      }
    } else {
      // HIT: zero regression. ON must match OFF on the EXACT deciding fields (score + role +
      // suppressed, not a qualifying band — a prime 3→2 same-family regression, OR a false→true
      // suppression flip that silently hides a good match, must not slip through), on every run,
      // and must NOT start surfacing a sub for an org that should stay out (the flood guard).
      const key = (r: Read) => `${r.seatFam}|${r.fit}|${r.disq}|${r.supp}|${r.role}`;
      const offKeys = new Set(off.map(key));
      expect(offKeys.size, "OFF should itself be stable for a hit fixture").toBe(1);
      expect(on.every((r) => offKeys.has(key(r))), "ON must not change a correct result").toBe(true);
      expect(on.some(isSubSurfaced) && !off.some(isSubSurfaced), "ON must not newly surface a sub here").toBe(false);
    }
  });
});
