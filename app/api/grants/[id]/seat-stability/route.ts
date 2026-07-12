import { NextRequest, NextResponse } from "next/server";
import { createClient, createServiceClient } from "@/lib/supabase/server";
import { matchGrantToClient } from "@/lib/grants/engine";
import { formatStoredUSASpending } from "@/lib/grants/usaspending";
import type { Client, Grant } from "@/types/database";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

// Seat-stability probe (scorer calibration). Admin-only, browser-openable.
//
// The seat-flicker bug is NONDETERMINISM: at temperature 0 the same (grant,
// client) sometimes resolves to a genuine supporting seat (score 2) and sometimes
// to NONE (score 0). This probe measures it directly -- it calls matchGrantToClient
// N times per client with IDENTICAL inputs and reports whether the seat CATEGORY
// (seated vs none) and the score are stable across runs.
//
// matchGrantToClient is side-effect-free (it calls the LLM and returns the result;
// the card / match_attempts writes live in the pipeline, not here), so this writes
// NOTHING -- no cards, no attempts, no lifecycle churn. Pure read + LLM calls.
//
//   GET /api/grants/<grantId>/seat-stability?clients=<id,id,...>&runs=8&profile=on
//
// Run it BEFORE the prompt fix to capture the baseline flicker, and AFTER to
// confirm stability. Keep runs modest so the whole probe fits the 300s window
// (calls = clients x runs x variants; a bounded pool runs them concurrently).
//
// profile=on (default) | off | both  -- Stage 4a A/B lever:
//   on   -> pass client_profile as stored (the new supplementary signal)
//   off  -> null client_profile before matching (byte-identical to pre-4a)
//   both -> run each client under BOTH variants so no-regression (calibration
//           set must hold) and improvement A/B read side-by-side in one probe.
// `both` DOUBLES the call count, so a budget guard (below) rejects oversized
// probes with guidance rather than letting them silently blow the 300s window.

const CONCURRENCY = 8;
const MAX_RUNS = 12;
// clients x runs x variants -- keep under the 300s window at CONCURRENCY 8
// (~40 calls ≈ 5 batches; beyond that `both` at high runs risks a timeout).
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

  // Budget guard: clients x runs x variants must fit the 300s window. Reject
  // oversized probes with concrete guidance instead of letting `both` silently
  // time out (e.g. 3 clients x 12 runs x 2 variants = 72 calls).
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

  // Flatten (client, variant, run) into one task list and drain it through a
  // bounded pool so the probe fits the 300s window. Within a variant the inputs
  // are identical each run -- the ONLY variable is model nondeterminism, which
  // is exactly what we are measuring; the variant is the deliberate A/B lever.
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
      // "off" nulls client_profile before matching -> byte-identical to pre-4a
      // clientContext; "on" passes the stored profile as the new signal.
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
      // The hard pass criterion for the flicker: no seated<->none category flip.
      stableSeat: categories.size === 1,
      stableScore: scores.size === 1,
      categories: [...categories],
      seatRefs: [...seatRefs],
      scores: [...scores].sort(),
      detail: rs,
    };
  };

  const report = clients.map((client) => ({
    clientId: client.id,
    name: client.name,
    // Present only the variant(s) actually run; both -> side-by-side A/B.
    profileOn: variants.includes("on") ? aggregate(byKey.get(key(client.id, "on")) ?? []) : null,
    profileOff: variants.includes("off") ? aggregate(byKey.get(key(client.id, "off")) ?? []) : null,
  }));

  return NextResponse.json({
    grantId: params.id,
    grantTitle: (grant as Grant).title ?? null,
    profile: profileParam,
    variants,
    runsPerClient: runs,
    totalCalls: tasks.length,
    report,
  });
}
