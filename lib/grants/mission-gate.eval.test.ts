import { describe, it, expect, beforeAll } from "vitest";
import { createServiceClient } from "@/lib/supabase/server";
import { matchGrantToClient } from "@/lib/grants/engine";
import { isMissionBasedReason } from "@/lib/grants/mission-gate";
import { formatStoredUSASpending } from "@/lib/grants/usaspending";
import { seatFamily } from "@/lib/grants/calibration";
import type { Client, Grant } from "@/types/database";

// ── Mission-gate eval (MATCH_MISSION_GATE_ENABLED) ─────────────────────────────────────────────
//
// MODEL-IN-THE-LOOP. NOT a unit test — the deterministic plumbing + the sub-routing interaction are
// proven in mission-gate.test.ts (that is the MERGE gate). THIS file is the FLIP gate: it makes real
// Anthropic calls and reads prod rows to check how the gate behaves on real matches. Skipped unless
// RUN_MISSION_GATE_EVAL=1 AND an ANTHROPIC_API_KEY is present (+ the Supabase service-role env):
//
//   RUN_MISSION_GATE_EVAL=1 MISSION_EVAL_RUNS=3 \
//   ANTHROPIC_API_KEY=... NEXT_PUBLIC_SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... \
//   npx vitest run lib/grants/mission-gate.eval.test.ts
//
// Each fixture is scored RUNS times with the gate OFF and RUNS times ON, asserting per band:
//   PRESERVE (zero-regression, the load-bearing safety assertion) — a genuine surfacing match must be
//     IDENTICAL ON vs OFF (seat family, EXACT fit, disq, supp, role). The gate must NEVER suppress a
//     match that surfaces. This is the "can't un-miss a real fit" guarantee, hard-asserted every run.
//   INTERSECTION (mission-gate × sub-routing #408, BOTH flags ON) — the state must be COHERENT: never
//     simultaneously suppressed AND surfaced-as-a-sub. A genuine sub (prime-ineligible specialist that
//     DOES the work) must NOT be suppressed by the mission-gate; a confident mission no-fit must NOT be
//     resurrected into a Sub seat. Proves the two live fixes can't fight.
//   SUPPRESS (DIAGNOSTIC — see the seeding note) — a confident mission no-fit. The hard assertion is
//     only the always-safe one (a no-fit must never START surfacing under the gate). Whether the gate
//     actually FIRES (suppressed=true) depends on the model emitting disqualified + NONE + a Gate-4
//     reason on that pair; the eval REPORTS the firing rate per run (the load-bearing observation) but
//     does not hard-fail on a no-fire, because model variance — not a gate bug — drives it.
//
// SEEDING NOTE (honest, not hidden). The gate fires only on the model's own confident-no-fit signal,
// so a *hard* "county is suppressed" assertion needs a prod pair CONFIRMED to trip all three signals —
// pulled from prod (row-level SELECT), which the sandbox cannot do. Until such a pair is pinned, the
// SUPPRESS band runs on the closest already-pinned no-fit (Arisa on a wrong-sector grant) as a
// DIAGNOSTIC. Before the flag is flipped: pin a real county/gov × entity-eligible-no-program grant,
// confirm the reported OFF signals are disqualified+NONE+mission-reason, then promote its assertion
// to `on.every(fired)`. The PRESERVE + INTERSECTION bands are already runnable and hard-asserted.

const RUN = process.env.RUN_MISSION_GATE_EVAL === "1" && !!process.env.ANTHROPIC_API_KEY;
// Positive-integer env knob with a fallback; blank/whitespace treated as absent (a cleared
// workflow_dispatch field submits "", which Number() would coerce to 0 and slip past isFinite).
const intEnv = (raw: string | undefined, def: number) => {
  const n = raw?.trim() ? Number(raw) : NaN;
  return Math.max(1, Number.isFinite(n) && n > 0 ? Math.floor(n) : def);
};
const RUNS = intEnv(process.env.MISSION_EVAL_RUNS, 3);
const CONCURRENCY = intEnv(process.env.MISSION_EVAL_CONCURRENCY, 6);
const FLAG = "MATCH_MISSION_GATE_ENABLED";
const SUBSEAT_FLAG = "MATCH_SUBSEAT_ROUTING_ENABLED";

// Concurrency-capped map: at most `cap` promises in flight at once; order preserved.
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

type Band = "preserve" | "suppress" | "intersection";
interface Fixture {
  label: string;
  client: string; // ilike against clients.name
  grantId: string; // pinned to grants.id (stable; NOFO titles re-normalize on re-ingest)
  band: Band;
}

// Grant ids pinned to real, profiled prod rows (Platform, gpqrzvnhxjsqerfczhqt) — reused from the
// subseat eval, where their behavior is already characterized:
const G_WATER_WORKFORCE = "43827e63-a945-4004-b56c-578013cd0ad2"; // Innovative Water Infrastructure Workforce Dev
const G_REENTRY_ED = "4335a5d5-611c-4258-b70f-52e8b494fe30"; // BJA Second Chance Act Improving Reentry Education
const G_FIRST_RESPONDERS_CARA = "e14b2acd-e780-4b05-a183-254228c788a5"; // First Responders–CARA (gov-only prime; subawards allowed)

const FIXTURES: Fixture[] = [
  // PRESERVE — a genuine, broadly-eligible match that surfaces today. The gate must never touch it.
  // (Subseat eval's HIT: "PTF / SC Reentry Education — genuine match, must stay".)
  { label: "PRESERVE: PTF / SC Reentry Education (genuine match must keep surfacing, gate ON == OFF)", client: "Pathway to Freedom", grantId: G_REENTRY_ED, band: "preserve" },
  // SUPPRESS (diagnostic) — Arisa (behavioral health) on a water-infrastructure workforce grant: a
  // wrong-SECTOR mission no-fit (subseat eval's "correct zero — wrong sector"). If the model returns
  // disqualified+NONE+mission-reason, the gate should fire; the eval REPORTS the rate.
  { label: "SUPPRESS(diag): Arisa / Water Infrastructure Workforce (wrong-sector mission no-fit — report firing)", client: "Arisa Health", grantId: G_WATER_WORKFORCE, band: "suppress" },
  // INTERSECTION — Arisa on First Responders-CARA: prime-INELIGIBLE (gov-only) but genuinely fills the
  // SUD direct-service sub-seat, i.e. it DOES the work. Under both flags ON: the mission-gate must NOT
  // fire (it does the work), and sub-routing may route it to Sub — and the state must never be both
  // suppressed AND sub-surfaced. Proves the mission-gate does not cannibalize a genuine sub.
  { label: "INTERSECTION: Arisa / First Responders-CARA (genuine sub — not mission-suppressed; coherent under both flags)", client: "Arisa Health", grantId: G_FIRST_RESPONDERS_CARA, band: "intersection" },
];

interface Read {
  seatFam: "prime" | "supporting" | "none";
  seat_ref: string | null;
  fit: number;
  role: string | null;
  disq: boolean;
  supp: boolean;
  disqReason: string | null;
  suppressReason: string | null;
  reasoning: string | null;
}

function read(m: {
  seat_ref?: string | null;
  fit_score: number;
  proposed_role?: string | null;
  disqualified?: boolean;
  suppressed?: boolean;
  disqualify_reason?: string | null;
  suppress_reason?: string | null;
  reasoning_context?: { fit_score_derivation?: string | null } | null;
}): Read {
  return {
    seatFam: seatFamily(m.seat_ref),
    seat_ref: m.seat_ref ?? null,
    fit: m.fit_score,
    role: m.proposed_role ?? null,
    disq: !!m.disqualified,
    supp: !!m.suppressed,
    disqReason: m.disqualify_reason ?? null,
    suppressReason: m.suppress_reason ?? null,
    reasoning: m.reasoning_context?.fit_score_derivation ?? null,
  };
}

interface Prepared {
  fx: Fixture;
  grant: Grant;
  client: Client;
  ctx: string | undefined;
}

// A card surfaces at fit_score >= 2 with no hard gate. A "sub surfaced" is that, in a supporting seat
// with a Sub/Co-Applicant role — the sub-routing target.
const isSurfaced = (r: Read) => r.fit >= 2 && !r.disq && !r.supp;
const isSubSurfaced = (r: Read) =>
  r.seatFam === "supporting" && r.fit === 2 && !r.disq && !r.supp && /sub|co-applicant/i.test(r.role ?? "");
// The gate fired iff it set suppressed with its own explainable reason (distinct from a model self-suppress).
const gateFired = (r: Read) => r.supp && /^Mission gate:/.test(r.suppressReason ?? "");
// The model's own confident-no-fit precondition on a gate-OFF read: disqualified + NONE seat + a
// Gate-4 mission reason (classified by the SAME helper the gate uses).
const noFitPrecondition = (r: Read) => r.disq && r.seatFam === "none" && isMissionBasedReason(r.disqReason);

// Score EVERY prepared fixture RUNS times under ONE mission-gate flag state. The subseat flag is
// pinned per band: INTERSECTION runs with subseat ON (that is the interaction under test); other
// bands mirror prod's non-subseat baseline. The mission flag is process-global, so it is set once per
// phase and all (fixture × run) calls fire concurrently (capped) — nothing races on the global.
async function scorePhase(prepared: Prepared[], on: boolean): Promise<Map<Fixture, Read[]>> {
  const prevMission = process.env[FLAG];
  const prevSubseat = process.env[SUBSEAT_FLAG];
  process.env[FLAG] = on ? "true" : "";
  try {
    const tasks = prepared.flatMap((p) => Array.from({ length: RUNS }, () => p));
    const reads = await mapCapped(tasks, CONCURRENCY, async (p) => {
      // Subseat routing ON only for the intersection band, so its interaction with the gate is what
      // that band actually exercises. Set per-call but consistent within a fixture (no race: the value
      // read at await-time is this task's).
      process.env[SUBSEAT_FLAG] = p.fx.band === "intersection" ? "true" : "";
      return read(await matchGrantToClient(p.grant, p.client, p.ctx));
    });
    const byFixture = new Map<Fixture, Read[]>();
    prepared.forEach((p, i) => byFixture.set(p.fx, reads.slice(i * RUNS, i * RUNS + RUNS)));
    return byFixture;
  } finally {
    if (prevMission === undefined) delete process.env[FLAG];
    else process.env[FLAG] = prevMission;
    if (prevSubseat === undefined) delete process.env[SUBSEAT_FLAG];
    else process.env[SUBSEAT_FLAG] = prevSubseat;
  }
}

const SCORING_WAVES = Math.ceil((FIXTURES.length * RUNS * 2) / CONCURRENCY);
const BEFORE_ALL_TIMEOUT_MS = Math.min(55 * 60_000, Math.max(10 * 60_000, SCORING_WAVES * 60_000));

describe.skipIf(!RUN)("mission-gate eval (model-in-the-loop)", () => {
  const RESULTS = new Map<Fixture, { off: Read[]; on: Read[] }>();

  beforeAll(async () => {
    const db = createServiceClient();
    const prepared: Prepared[] = [];
    for (const fx of FIXTURES) {
      const { data: client, error: clientErr } = await db
        .from("clients")
        .select("*")
        .ilike("name", fx.client)
        .limit(1)
        .maybeSingle<Client>();
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

      const ctx = client.federal_history_verified
        ? undefined
        : formatStoredUSASpending(client.usaspending_summary);
      prepared.push({ fx, grant, client, ctx });
    }

    const off = await scorePhase(prepared, false);
    const on = await scorePhase(prepared, true);

    const fmt = (r: Read) => `${r.seat_ref}/${r.fit}/${r.role}${r.disq ? "/DISQ" : ""}${r.supp ? "/SUPP" : ""}`;
    const why = (r: Read) =>
      [r.disqReason && `disq="${r.disqReason}"`, r.suppressReason && `supp="${r.suppressReason}"`]
        .filter(Boolean)
        .join(" | ") || "(no reason given)";
    for (const p of prepared) {
      const o = off.get(p.fx)!;
      const n = on.get(p.fx)!;
      RESULTS.set(p.fx, { off: o, on: n });
      const firedRate = `${n.filter(gateFired).length}/${n.length}`;
      const preconRate = `${o.filter(noFitPrecondition).length}/${o.length}`;
      console.log(
        [
          `[${p.fx.band}] ${p.fx.label}`,
          `  OFF: ${o.map(fmt).join(" | ")}`,
          `  ON : ${n.map(fmt).join(" | ")}`,
          `  no-fit precondition on OFF: ${preconRate} | gate fired on ON: ${firedRate}`,
          `  why OFF[0]: ${why(o[0])}`,
          ...n.map((r, i) => `  why ON[${i}]: ${why(r)}`),
        ].join("\n"),
      );
    }
  }, BEFORE_ALL_TIMEOUT_MS);

  it.each(FIXTURES)("$label", (fx) => {
    const res = RESULTS.get(fx);
    expect(res, `no scoring result recorded for ${fx.label}`).toBeTruthy();
    if (!res) return;
    const { off, on } = res;

    if (fx.band === "preserve") {
      // Zero regression: OFF is itself stable and surfaces; ON matches OFF on every deciding field,
      // every run. The gate must NEVER suppress or alter a genuine surfacing match.
      const key = (r: Read) => `${r.seatFam}|${r.fit}|${r.disq}|${r.supp}|${r.role}`;
      const offKeys = new Set(off.map(key));
      expect(offKeys.size, "OFF should be stable for a preserve fixture").toBe(1);
      expect(off.every(isSurfaced), "the preserve fixture should surface with the gate OFF").toBe(true);
      expect(on.every((r) => offKeys.has(key(r))), "gate ON must not change a surfacing match").toBe(true);
      expect(on.some(gateFired), "the gate must NEVER fire on a surfacing match").toBe(false);
    } else if (fx.band === "intersection") {
      // Coherence under BOTH flags ON: never simultaneously suppressed AND surfaced-as-a-sub, on any
      // run. And a genuine sub (does the work) must not be mission-suppressed.
      expect(on.every((r) => !(r.supp && isSubSurfaced(r))), "must never be both suppressed and sub-surfaced").toBe(true);
      expect(on.some(gateFired), "a genuine sub (does the work) must not be mission-gate suppressed").toBe(false);
    } else {
      // SUPPRESS (diagnostic): the always-safe hard assertion — a confident no-fit must never START
      // surfacing under the gate (the gate only ever suppresses / no-ops; it cannot lift a score).
      // The firing rate is reported in beforeAll's log; promote to `on.every(gateFired)` once a
      // CONFIRMED county/gov no-program pair is pinned here (see the SEEDING NOTE).
      expect(on.some(isSurfaced), "SUPPRESS: a mission no-fit must never surface under the gate").toBe(false);
      // Teeth when the data supports it: on any ON run whose model output itself hits the no-fit
      // precondition, the gate MUST have fired (this is deterministic given the helper, so it catches
      // a wiring regression — the gate not running in the engine — without depending on model stability).
      for (const r of on) {
        if (noFitPrecondition(r) && !gateFired(r)) {
          // r met all three signals pre-gate but was not suppressed → the engine hook is not wired.
          expect.fail(`no-fit precondition met but gate did not fire — engine hook not wired? ${r.seat_ref}/${r.fit} disq="${r.disqReason}"`);
        }
      }
    }
  });
});
