import { NextResponse } from "next/server";
import { createClient, createServiceClient } from "@/lib/supabase/server";
import { drainClientMatchQueue } from "@/lib/clients/match-queue";
import { anyClientMatchPending } from "@/lib/clients/match-queue-guard";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

// Admin-only, on-demand drain of the client one-time-match queue. Same drain the
// /api/cron/client-match cron runs on a schedule, but authed by an ADMIN SESSION
// (not Bearer) so it is browser-openable on a preview while logged in -- crons run
// only against production, so this is how a queued prospect gets matched (and the
// "scored X of Y" banner verified) on a preview. Mirrors /api/grants/drain-match-queue.
//
// GET on purpose (browser-openable); admin-gated because it triggers paid LLM work.
export async function GET() {
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

  // Same empty-queue fast-path as the cron: don't pay the drain's ~2.4s whole-pool
  // load when nothing is queued. Correct for the manual caller too -- an empty queue
  // has nothing to drain, so this returns the same queueEmpty result the drain would.
  if (!(await anyClientMatchPending(db))) {
    return NextResponse.json({
      advanced: 0,
      completed: 0,
      errored: 0,
      advancedIds: [],
      completedIds: [],
      errors: [],
      queueEmpty: true,
      budgetExhausted: false,
      skipped: "no_pending_clients",
    });
  }

  const result = await drainClientMatchQueue(db);

  return NextResponse.json({
    advanced: result.advanced.length,
    completed: result.completed.length,
    errored: result.errored.length,
    advancedIds: result.advanced,
    completedIds: result.completed,
    errors: result.errored,
    queueEmpty: result.queueEmpty,
    budgetExhausted: result.budgetExhausted,
  });
}
