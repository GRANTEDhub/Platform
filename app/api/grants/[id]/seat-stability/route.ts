import { NextRequest, NextResponse } from "next/server";
import { createClient, createServiceClient } from "@/lib/supabase/server";
import { matchGrantToClient } from "@/lib/grants/engine";
import { formatStoredUSASpending } from "@/lib/grants/usaspending";
import type { Client, Grant } from "@/types/database";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

// Seat-stability probe (scorer calibration) + PROFILE-INVARIANCE guard.
//
// Two jobs:
// 1. Flicker: at temperature 0 the same (grant, client) should resolve to the
//    same seat CATEGORY (seated vs none) and score across runs. This probe calls
//    matchGrantToClient N times with identical inputs and reports stability.
// 2. Profile invariance (Stage 4 redesign): occupancy is now PROFILE-FREE --
//    matchGrantToClient never reads client_profile; the profile only feeds the
//    separate enrichment call. profile=both nulls client_profile for the "off"
//    variant and passes it for "on"; occupancy MUST be identical. profileInvariant
//    is the standing canary: if it ever goes false, someone re-coupled the profile
//    to occupancy (the exact regression this redesign removed).
//
// matchGrantToClient is side-effect-free (card / match_attempts writes live in the
// pipeline, not here), so this writes NOTHING -- pure read + LLM calls.
//
//   GET /api/grants/<grantId>/seat-stability?clients=<id,id,...>&runs=8&profile=on
//
// profile=on (default) | off | both. `both` DOUBLES calls, so a budget guard
// rejects oversized probes rather than blowing the 300s window.

const CONCURRENCY = 8;
const MAX_RUNS = 12;
// clients x runs x variants -- keep under the 300s window at CONCURRENCY 8.
const MAX_CALLS = 40;
type Variant = "on" | "off";

type RunResult = {
  seatRef: string | null;
  fitScore: number | null;
  proposedRole: string | null;
  derivation?: string | null; // reasoning_context.fit_score_derivation -- WHY this score
  roleLogic?: string | null; // reasoning_context.role_assignment_logic -- WHY this seat
  error?: string;
};

const category = (seatRef: string | null) => (seatRef && seatRef !== "NONE" ? "seated" : "none");

export async function GET(req: NextRequest, { params }: { params: { id: string } }) {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  const { data: profile } = await supabase
    .from("profiles")
    .select("role")
    .eq("id", user.id)
    .single();
  if (profile?.role !== "admin") return NextResponse.json({ error: "Admins only" }, { status: 403 });

  const clientIds = (req.nextUrl.searchParams.get("clients") ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (clientIds.length === 0) {
    return NextResponse.json({ error: "Provide ?clients=<id,id,...>" }, { status: 400 });
  }
  const runs = Math.min(
    MAX_RUNS,
    Math.max(1, parseInt(req.nextUrl.searchParams.get("runs") ?? "8", 10) || 8),
  );

  const profileParam = (req.nextUrl.searchParams.get("profile") ?? "on").toLowerCase();
  if (!["on", "off", "both"].includes(profileParam)) {
    return NextResponse.json(
      { error: "profile must be one of: on (default), off, both" },
      { status: 400 },
    );
  }
  const variants: Variant[] = profileParam === "both" ? ["off", "on"] : [profileParam as Variant];

  const db = createServiceClient();
  const { data: grant } = await db.from("grants").select("*").eq("id", params.id).single();
  if (!grant) return NextResponse.json({ error: "Grant not found" }, { status: 404 });

  const { data: clientRows } = await db.from("clients").select("*").in("id", clientIds);
  const clients = (clientRows ?? []) as Client[];
  if (clients.length === 0) {
    return NextResponse.json({ error: "No clients found for those ids" }, { status: 404 });
  }

  // Budget guard: clients x runs x variants must fit the 300s window.
  const plannedCalls = clients.length * runs * variants.length;
  if (plannedCalls > MAX_CALLS) {
    return NextResponse.json(
      {
        error: `Probe too large: ${clients.length} clients x ${runs} runs x ${variants.length} variant(s) = ${plannedCalls} calls exceeds the ${MAX_CALLS}-call budget (300s window at concurrency ${CONCURRENCY}).`,
        guidance: `Reduce runs, split the client list, or use a single profile variant. Max runs for this shape: ${Math.max(1, Math.floor(MAX_CALLS / (clients.length * variants.length)))}.`,
      },
      { status: 400 },
    );
  }

  // Flatten (client, variant, run) into one task list and drain through a bounded
  // pool. Within a variant the inputs are identical -- the only variable is model
  // nondeterminism (the flicker); the variant is the profile-invariance lever.
  const tasks: { client: Client; variant: Variant; run: number }[] = [];
  for (const client of clients)
    for (const variant of variants) for (let r = 0; r < runs; r++) tasks.push({ client, variant, run: r });

  const key = (clientId: string, variant: Variant) => `${clientId}::${variant}`;
  const byKey = new Map<string, RunResult[]>();
  for (const client of clients) for (const variant of variants) byKey.set(key(client.id, variant), []);

  let next = 0;
  async function worker() {
    while (true) {
      const i = next++;
      if (i >= tasks.length) return;
      const { client, variant } = tasks[i];
      // "off" nulls client_profile. Occupancy is profile-free, so this MUST NOT
      // change the result -- that is exactly what profileInvariant checks.
      const effective = variant === "off" ? { ...client, client_profile: null } : client;
      const ctx = client.federal_history_verified
        ? undefined
        : formatStoredUSASpending(client.usaspending_summary);
      try {
        const m = await matchGrantToClient(grant as Grant, effective, ctx);
        const rc = (m as { reasoning_context?: Record<string, string> | null }).reasoning_context;
        byKey.get(key(client.id, variant))!.push({
          seatRef: m.seat_ref ?? null,
          fitScore: m.fit_score ?? null,
          proposedRole: m.proposed_role ?? null,
          derivation: rc?.fit_score_derivation ? rc.fit_score_derivation.slice(0, 400) : null,
          roleLogic: rc?.role_assignment_logic ? rc.role_assignment_logic.slice(0, 400) : null,
        });
      } catch (err) {
        byKey.get(key(client.id, variant))!.push({
          seatRef: null,
          fitScore: null,
          proposedRole: null,
          error: String(err instanceof Error ? err.message : err).slice(0, 200),
        });
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, tasks.length) }, worker));

  // Per-variant aggregate for one client -- the flicker verdict + the raw runs.
  const aggregate = (rs: RunResult[]) => {
    const categories = new Set(rs.map((r) => category(r.seatRef)));
    const scores = new Set(rs.map((r) => r.fitScore));
    const seatRefs = new Set(rs.map((r) => r.seatRef ?? "NONE"));
    return {
      runs: rs.length,
      stableSeat: categories.size === 1,
      stableScore: scores.size === 1,
      categories: [...categories],
      seatRefs: [...seatRefs],
      scores: [...scores].sort(),
      detail: rs,
    };
  };

  const report = clients.map((client) => {
    const on = variants.includes("on") ? aggregate(byKey.get(key(client.id, "on")) ?? []) : null;
    const off = variants.includes("off") ? aggregate(byKey.get(key(client.id, "off")) ?? []) : null;
    // Invariance guard: when both variants ran, occupancy (seat category + score
    // set) MUST match. A mismatch means the profile leaked back into occupancy.
    const profileInvariant =
      on && off
        ? JSON.stringify(on.categories.sort()) === JSON.stringify(off.categories.sort()) &&
          JSON.stringify(on.scores) === JSON.stringify(off.scores)
        : null;
    return { clientId: client.id, name: client.name, profileOn: on, profileOff: off, profileInvariant };
  });

  return NextResponse.json({
    grantId: params.id,
    grantTitle: (grant as Grant).title ?? null,
    profile: profileParam,
    variants,
    runsPerClient: runs,
    totalCalls: tasks.length,
    // True only when profile=both ran and occupancy matched for every client.
    allProfileInvariant:
      variants.length === 2 ? report.every((r) => r.profileInvariant === true) : null,
    report,
  });
}
