import { describe, it, expect } from "vitest";
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
const FLAG = "MATCH_SUBSEAT_ROUTING_ENABLED";

type Band = "miss" | "hit" | "carveout";
interface Fixture {
  label: string;
  client: string; // ilike against clients.name
  grantLike: string; // ilike against grants.title
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
const FIXTURES: Fixture[] = [
  { label: "PTF / Smart Reentry (gov-only; PTF fills the reentry-provider sub-seat)", client: "Pathway to Freedom", grantLike: "%smart reentry%", band: "miss" },
  { label: "PTF / Public Safety & Mental Health (gov-only sub)", client: "Pathway to Freedom", grantLike: "%public safety and mental health%", band: "miss" },
  { label: "PTF / SC Reentry Education (broad eligibility — genuine match, must stay)", client: "Pathway to Freedom", grantLike: "%improving reentry education%", band: "hit" },
  { label: "Arisa / Water Infrastructure Workforce (correct zero — wrong sector)", client: "Arisa Health", grantLike: "%water infrastructure workforce%", band: "hit" },
  { label: "Arisa / Rural Housing Preservation (correct zero — no housing program)", client: "Arisa Health", grantLike: "%rural housing preservation%", band: "hit" },
  // ── DEFER-FIRST carve-outs (all on the PTF / Smart Reentry base) ────────────────────────────
  {
    label: "CARVE-OUT for-profit: PTF re-typed for-profit — HARD ROLE RULE (Facilitator only) wins, never Sub",
    client: "Pathway to Freedom",
    grantLike: "%smart reentry%",
    band: "carveout",
    mutate: ({ client }) => {
      client.org_type = "For-Profit / Commercial";
    },
  },
  {
    label: "CARVE-OUT subaward-prohibited: same grant flagged subaward_prohibited — Facilitator collapse wins, never Sub",
    client: "Pathway to Freedom",
    grantLike: "%smart reentry%",
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
    grantLike: "%smart reentry%",
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

async function scoreN(grant: Grant, client: Client, on: boolean): Promise<Read[]> {
  const prev = process.env[FLAG];
  process.env[FLAG] = on ? "true" : "";
  try {
    const ctx = client.federal_history_verified
      ? undefined
      : formatStoredUSASpending(client.usaspending_summary);
    const out: Read[] = [];
    for (let i = 0; i < RUNS; i++) {
      out.push(read(await matchGrantToClient(grant, client, ctx)));
    }
    return out;
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
  it.each(FIXTURES)("$label", async (fx) => {
    // Created inside the test, not at suite top: describe.skipIf still runs the suite callback
    // during collection, so a top-level createServiceClient() would fire (and throw on missing
    // Supabase env) even in a skipped/sandbox run.
    const db = createServiceClient();
    const { data: client } = await db
      .from("clients")
      .select("*")
      .ilike("name", fx.client)
      .limit(1)
      .maybeSingle<Client>();
    const { data: grant } = await db
      .from("grants")
      .select("*")
      .ilike("title", fx.grantLike)
      .not("ideal_applicant_profile", "is", null)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle<Grant>();

    expect(client, `client not found: ${fx.client}`).toBeTruthy();
    expect(grant, `grant not found (or no profile): ${fx.grantLike}`).toBeTruthy();
    if (!client || !grant) return;

    // Carve-out: apply the single DEFER-FIRST trigger in place before either OFF or ON scores it,
    // so both sides see the same mutated base and the only variable is the flag.
    if (fx.mutate) fx.mutate({ client, grant });

    const off = await scoreN(grant, client, false);
    const on = await scoreN(grant, client, true);
    // Surfaced to the console (helps read the report even on a pass). supp is shown because a
    // suppression flip is a HIT/carve-out regression that the seat/fit/role columns alone hide.
    const fmt = (r: Read) => `${r.seat_ref}/${r.fit}/${r.role}${r.disq ? "/DISQ" : ""}${r.supp ? "/SUPP" : ""}`;
    console.log(`[${fx.band}] ${fx.label}\n  OFF: ${off.map(fmt).join(" | ")}\n  ON : ${on.map(fmt).join(" | ")}`);

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
    // Each fixture makes 2*RUNS sequential real Anthropic calls (OFF then ON). Scale the
    // per-fixture timeout with RUNS so raising SUBSEAT_EVAL_RUNS can't fail on a Vitest
    // timeout instead of the routing assertions. At the default RUNS=3 this is 180_000 (unchanged).
  }, Math.max(180_000, 60_000 * RUNS));
});
