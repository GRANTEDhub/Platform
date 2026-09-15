// Fit-analysis narrative drain — runs on the Vercel Cron schedule.
//
// Polls for stale GO/MARGINAL (displayed fit 2/3) pending client cards and generates the client-facing
// "why this client fits" paragraph on a cost-capped batch, writing ONLY the fit_narrative* columns (never
// fit_score / seat / decision / qa_*). NON-SCORING and NO fetch — it runs on stored data (client profile +
// grant brief + program award history + engine role read). Gated behind FIT_ANALYSIS_ENABLED (default OFF)
// — off, runFitAnalysis returns immediately and this route is a no-op, byte-identical to today.
//
// Auth: Bearer CRON_SECRET (cronDeny, fail-closed in prod) — same as the other cron routes. The service
// client is non-cached (createServiceClient sets cache:no-store — the drain-cache incident rule), which
// matters because the poll's stable-URL SELECTs must not be served stale.

import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/server";
import { cronDeny } from "@/lib/cron/auth";
import { runFitAnalysis } from "@/lib/grants/fit-analysis";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function GET(req: NextRequest) {
  const deny = cronDeny(req);
  if (deny) return deny;

  const db = createServiceClient();
  const result = await runFitAnalysis(db);

  return NextResponse.json(result);
}
