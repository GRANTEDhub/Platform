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
//   HIT set — ON must be INDISTINGUISHABLE from OFF on the deciding fields (seat family,
//     fit_score band, disqualified) — the zero-regression bar. Guards against the flood failure
//     mode (the addendum must not start surfacing sub-fits for orgs that should stay out).
//
// KNOWN LIMITATION (documented, not hidden): the miss set is Pathway-to-Freedom-concentrated —
// PTF is the only clean client-side example (Harbor House self-suppresses via its capital-only
// matching rule; NW Arkansas Land Trust is not a client). If a second clean non-PTF sub-only
// case appears in the roster, add it here.

const RUN = process.env.RUN_SUBSEAT_EVAL === "1" && !!process.env.ANTHROPIC_API_KEY;
const RUNS = Math.max(1, Number(process.env.SUBSEAT_EVAL_RUNS ?? 3));
const FLAG = "MATCH_SUBSEAT_ROUTING_ENABLED";

type Band = "miss" | "hit";
interface Fixture {
  label: string;
  client: string; // ilike against clients.name
  grantLike: string; // ilike against grants.title
  band: Band;
}

// Miss = should START surfacing as a sub. Hit = must NOT change (correct today).
const FIXTURES: Fixture[] = [
  { label: "PTF / Smart Reentry (gov-only; PTF fills the reentry-provider sub-seat)", client: "Pathway to Freedom", grantLike: "%smart reentry%", band: "miss" },
  { label: "PTF / Public Safety & Mental Health (gov-only sub)", client: "Pathway to Freedom", grantLike: "%public safety and mental health%", band: "miss" },
  { label: "PTF / SC Reentry Education (broad eligibility — genuine match, must stay)", client: "Pathway to Freedom", grantLike: "%improving reentry education%", band: "hit" },
  { label: "Arisa / Water Infrastructure Workforce (correct zero — wrong sector)", client: "Arisa Health", grantLike: "%water infrastructure workforce%", band: "hit" },
  { label: "Arisa / Rural Housing Preservation (correct zero — no housing program)", client: "Arisa Health", grantLike: "%rural housing preservation%", band: "hit" },
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

    const off = await scoreN(grant, client, false);
    const on = await scoreN(grant, client, true);
    // Surfaced to the console (helps read the report even on a pass).
    console.log(`[${fx.band}] ${fx.label}\n  OFF: ${off.map((r) => `${r.seat_ref}/${r.fit}/${r.role}${r.disq ? "/DISQ" : ""}`).join(" | ")}\n  ON : ${on.map((r) => `${r.seat_ref}/${r.fit}/${r.role}${r.disq ? "/DISQ" : ""}`).join(" | ")}`);

    if (fx.band === "miss") {
      // ON surfaces the sub on EVERY run (stability); NO OFF run surfaces it (proves the addendum,
      // not model variance, is the cause — .some, not .every, or a flaky baseline would pass).
      expect(on.every(isSubSurfaced), "ON should surface a supporting seat on every run").toBe(true);
      expect(off.some(isSubSurfaced), "NO OFF run should surface it (proves the addendum caused it)").toBe(false);
    } else {
      // HIT: zero regression. ON must match OFF on the EXACT deciding fields (score + role, not a
      // qualifying band — a prime 3→2 same-family regression must not slip through), on every run,
      // and must NOT start surfacing a sub for an org that should stay out (the flood guard).
      const key = (r: Read) => `${r.seatFam}|${r.fit}|${r.disq}|${r.role}`;
      const offKeys = new Set(off.map(key));
      expect(offKeys.size, "OFF should itself be stable for a hit fixture").toBe(1);
      expect(on.every((r) => offKeys.has(key(r))), "ON must not change a correct result").toBe(true);
      expect(on.some(isSubSurfaced) && !off.some(isSubSurfaced), "ON must not newly surface a sub here").toBe(false);
    }
  }, 180_000);
});
