import { NextResponse } from "next/server";
import { createClient, createServiceClient } from "@/lib/supabase/server";
import { runWatchdogSweep } from "@/lib/grants/watchdog";

export const dynamic = "force-dynamic";

// Admin-only, on-demand run of the stuck-pipeline watchdog (the same sweep the
// /api/cron/watchdog cron runs on a schedule), authed by an ADMIN SESSION so it
// is browser-openable while logged in -- mirrors the drain-match-queue trigger.
// Needed because Vercel crons run only against production, so the scheduled sweep
// never fires on a preview; this lets an admin exercise it there (e.g. after
// forcing a grant into a stale 'matching' state to verify requeue/error).
//
// GET on purpose (browser-openable); admin-gated. The response summarizes what
// the sweep did.
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

  try {
    const result = await runWatchdogSweep(createServiceClient());
    return NextResponse.json(result);
  } catch (err) {
    console.error(String(err instanceof Error ? err.message : err));
    return NextResponse.json({ error: "Watchdog sweep failed" }, { status: 500 });
  }
}
