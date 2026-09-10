// AR scraper — the manual "check now" tool (admin-only). The look-before-you-flip surface.
//
//   GET  = read-only DRY-RUN: fetch + classify every source and report exactly what WOULD happen
//          (new opportunities, loans that would be skipped, PDFs that would be flagged, deadline
//          changes) WITHOUT any write. Browser-openable, safe to prefetch.
//   POST = APPLY: run the real scan (upsert items, promote grant-type hits, record hashes). POST-only
//          so a link scanner / prefetch can never trigger the write — same GET-safe/POST-mutates
//          discipline as the closed-sweep + intel-backfill admin routes.
//
// Admin-gated inline (JSON route → return JSON, not a redirect). Service-role client for the work.
// Not flag-gated: it is the deliberate manual control (the cron carries the schedule).

import { NextRequest, NextResponse } from "next/server";
import { createClient, createServiceClient } from "@/lib/supabase/server";
import { runArGrantsScan, type PromoteFn } from "@/lib/ar-grants/run";
import { promoteOpportunity } from "@/lib/ar-grants/promote";

export const dynamic = "force-dynamic";
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

// Dry-run never invokes promote (apply=false), so a no-op satisfies the type without reaching the pipeline.
const noPromote: PromoteFn = async () => ({ grantId: null, action: "failed" });

export async function GET(req: NextRequest) {
  const deny = await requireAdmin();
  if (deny) return deny;
  try {
    const report = await runArGrantsScan(createServiceClient(), { apply: false, promote: noPromote });
    return NextResponse.json(report);
  } catch (err) {
    console.error("AR grants dry-run failed:", err instanceof Error ? err.message : err);
    return NextResponse.json({ error: "AR grants dry-run failed" }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  const deny = await requireAdmin();
  if (deny) return deny;
  try {
    const report = await runArGrantsScan(createServiceClient(), {
      apply: true,
      promote: (db, ctx) => promoteOpportunity(db, ctx),
    });
    return NextResponse.json(report);
  } catch (err) {
    console.error("AR grants apply failed:", err instanceof Error ? err.message : err);
    return NextResponse.json({ error: "AR grants apply failed" }, { status: 500 });
  }
}
