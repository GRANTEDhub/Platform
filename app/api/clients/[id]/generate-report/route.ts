import { NextRequest, NextResponse } from "next/server";
import { createClient, createServiceClient } from "@/lib/supabase/server";
import { drainClientMatchQueue } from "@/lib/clients/match-queue";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

// Per-round drain budget for the client-driven continuation loop. Kept comfortably
// under Cloudflare's ~100s origin-response limit (prod fronts app.grantedco.com with
// Cloudflare; a longer awaited request would 524) AND under maxDuration. Each round
// scores whatever fits in this window; the dashboard re-POSTs until `done`, so a pool
// of any size finishes from a single "Generate report" click with no cron wait.
const CONTINUE_BUDGET_MS = 75_000;

// Admin-only, on-demand "Generate report" — ONE round of the client one-time match.
// The client->pool mirror of the grant->roster "Re-match" button. It only manages
// initial_match_status and runs the SAME drainClientMatchQueue the cron runs (no
// matching logic here). The drain is incremental (scores only pool grants not yet
// attempted for this record), lease-serialized (never double-scores against the cron
// or a second tab), and resumable. The dashboard button loops POST->(<=75s)->POST
// until this response reports { done: true }, so the match completes from one click
// with no manual SQL/route-poking.
//
// POST (state-changing, admin-gated because it can trigger paid LLM work).
export async function POST(_req: NextRequest, { params }: { params: { id: string } }) {
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

  const db = createServiceClient();
  const { data: client } = await db
    .from("clients")
    .select("id, initial_match_status")
    .eq("id", params.id)
    .single();
  if (!client) return NextResponse.json({ error: "Record not found" }, { status: 404 });

  // Enqueue only when NOT already in flight. A first click / re-run (null, 'complete',
  // 'error') is (re)queued with the lease cleared so the drain claims it immediately.
  // A continuation round ('queued'/'running') is left as-is -- the drain resumes it via
  // the lease. Concurrency is enforced in the drain (the lease), not here, so a second
  // tab or the cron can't double-score even if both POST.
  const inFlight =
    client.initial_match_status === "queued" || client.initial_match_status === "running";
  if (!inFlight) {
    await db
      .from("clients")
      .update({ initial_match_status: "queued", match_locked_at: null })
      .eq("id", params.id);
  }

  // Drive ONE bounded round, awaited (not waitUntil) so we can tell the client whether
  // to loop again. drainClientMatchQueue drains the whole queue oldest-first; this
  // record is scored within this round (or a subsequent one), and we report ITS status.
  await drainClientMatchQueue(db, { budgetMs: CONTINUE_BUDGET_MS });

  const { data: after } = await db
    .from("clients")
    .select("initial_match_status")
    .eq("id", params.id)
    .single();
  const status = after?.initial_match_status ?? null;
  const done = status === "complete" || status === "error";

  return NextResponse.json({ ok: true, done, status }, { status: 200 });
}
