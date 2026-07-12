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
//   GET /api/grants/<grantId>/seat-stability?clients=<id,id,...>&runs=8
//
// Run it BEFORE the prompt fix to capture the baseline flicker, and AFTER to
// confirm stability. Keep runs modest so the whole probe fits the 300s window
// (calls = clients x runs; a bounded pool runs them concurrently).

const CONCURRENCY = 8;
const MAX_RUNS = 12;

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

  const db = createServiceClient();
  const { data: grant } = await db.from("grants").select("*").eq("id", params.id).single();
  if (!grant) return NextResponse.json({ error: "Grant not found" }, { status: 404 });

  const { data: clientRows } = await db.from("clients").select("*").in("id", clientIds);
  const clients = (clientRows ?? []) as Client[];
  if (clients.length === 0) {
    return NextResponse.json({ error: "No clients found for those ids" }, { status: 404 });
  }

  // Flatten (client, run) into one task list and drain it through a bounded pool
  // so the probe fits the 300s window. Identical inputs each run -- the ONLY
  // variable is model nondeterminism, which is exactly what we are measuring.
  const tasks: { client: Client; run: number }[] = [];
  for (const client of clients) for (let r = 0; r < runs; r++) tasks.push({ client, run: r });

  const byClient = new Map<string, RunResult[]>();
  for (const client of clients) byClient.set(client.id, []);

  let next = 0;
  async function worker() {
    while (true) {
      const i = next++;
      if (i >= tasks.length) return;
      const { client } = tasks[i];
      const ctx = client.federal_history_verified
        ? undefined
        : formatStoredUSASpending(client.usaspending_summary);
      try {
        const m = await matchGrantToClient(grant as Grant, client, ctx);
        const rc = (m as { reasoning_context?: Record<string, string> | null }).reasoning_context;
        byClient.get(client.id)!.push({
          seatRef: m.seat_ref ?? null,
          fitScore: m.fit_score ?? null,
          proposedRole: m.proposed_role ?? null,
          derivation: rc?.fit_score_derivation ? rc.fit_score_derivation.slice(0, 400) : null,
          roleLogic: rc?.role_assignment_logic ? rc.role_assignment_logic.slice(0, 400) : null,
        });
      } catch (err) {
        byClient.get(client.id)!.push({
          seatRef: null,
          fitScore: null,
          proposedRole: null,
          error: String(err instanceof Error ? err.message : err).slice(0, 200),
        });
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, tasks.length) }, worker));

  const report = clients.map((client) => {
    const rs = byClient.get(client.id) ?? [];
    const categories = new Set(rs.map((r) => category(r.seatRef)));
    const scores = new Set(rs.map((r) => r.fitScore));
    const seatRefs = new Set(rs.map((r) => r.seatRef ?? "NONE"));
    return {
      clientId: client.id,
      name: client.name,
      runs: rs.length,
      // The hard pass criterion for the flicker: no seated<->none category flip.
      stableSeat: categories.size === 1,
      stableScore: scores.size === 1,
      categories: [...categories],
      seatRefs: [...seatRefs],
      scores: [...scores].sort(),
      detail: rs,
    };
  });

  return NextResponse.json({
    grantId: params.id,
    grantTitle: (grant as Grant).title ?? null,
    runsPerClient: runs,
    totalCalls: tasks.length,
    report,
  });
}
