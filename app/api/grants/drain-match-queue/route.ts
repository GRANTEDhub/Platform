import { NextResponse } from "next/server";
import { createClient, createServiceClient } from "@/lib/supabase/server";
import { drainMatchQueue } from "@/lib/grants/queue";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

// Admin-only, on-demand drain of the matching queue (Move 2). Same drain the
// /api/cron/match cron runs on a schedule, but authed by an ADMIN SESSION (not
// Bearer) so it is browser-openable on the real app / a preview while logged in
// -- mirrors the backfill routes. Use it to verify a manually-enqueued test grant
// without needing to send a CRON_SECRET bearer from a terminal.
//
// GET on purpose (browser-openable); admin-gated because it triggers paid LLM
// work. The response summarizes what drained.
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
  const result = await drainMatchQueue(db);

  return NextResponse.json({
    drained: result.processed.length,
    errored: result.errored.length,
    processed: result.processed,
    errors: result.errored,
    queueEmpty: result.queueEmpty,
    budgetExhausted: result.budgetExhausted,
  });
}
