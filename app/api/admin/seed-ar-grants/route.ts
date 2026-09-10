// AR state repository — the one-time seed control (admin-only). The look-before-you-seed surface.
//
//   GET  = read-only DRY-RUN: reports what WOULD seed / skip (already in the corpus) and, for a
//          verify_url entry — or every URL with ?probe=all — whether the page is reachable. Writes
//          NOTHING. Browser-openable, safe to prefetch.
//   POST = APPLY: seed the fixture into the repository (insert grant shell + monitor_state row + a full
//          shred+match per entry). TIME-BUDGETED + IDEMPOTENT — one request seeds as many as fit, the
//          rest report as `remaining`; POST again to continue. POST-only so a link scanner / prefetch
//          can never trigger the write. Optional ?limit=N caps entries per call.
//
// Admin-gated inline (JSON route → JSON, not a redirect). Service-role client for the work. Node
// runtime + the Chromium trace (headless AEDC/DFA render), matching the alert/AR-grants routes.

import { NextRequest, NextResponse } from "next/server";
import { createClient, createServiceClient } from "@/lib/supabase/server";
import { runSeed } from "@/lib/ar-state/seed";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 300;

async function requireAdmin(): Promise<NextResponse | null> {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  const { data: profile } = await supabase.from("profiles").select("role").eq("id", user.id).single();
  if (profile?.role !== "admin") return NextResponse.json({ error: "Admins only" }, { status: 403 });
  return null;
}

export async function GET(req: NextRequest) {
  const deny = await requireAdmin();
  if (deny) return deny;
  try {
    const probeReach = new URL(req.url).searchParams.get("probe") === "all";
    const report = await runSeed(createServiceClient(), { apply: false, probeReach });
    return NextResponse.json(report);
  } catch (err) {
    console.error("AR-state seed dry-run failed:", err instanceof Error ? err.message : err);
    return NextResponse.json({ error: "AR-state seed dry-run failed" }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  const deny = await requireAdmin();
  if (deny) return deny;
  try {
    const limitParam = new URL(req.url).searchParams.get("limit");
    const limit = limitParam ? Math.max(1, Math.min(40, Number(limitParam) || 0)) || undefined : undefined;
    const report = await runSeed(createServiceClient(), { apply: true, limit });
    return NextResponse.json(report);
  } catch (err) {
    console.error("AR-state seed apply failed:", err instanceof Error ? err.message : err);
    return NextResponse.json({ error: "AR-state seed apply failed" }, { status: 500 });
  }
}
