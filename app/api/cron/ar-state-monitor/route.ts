// AR state repository — the WEEKLY monitor cron.
//
// Re-fetches every monitored AR program page (headless where the domain needs it), diffs its content
// hash, and on a real change re-derives the grant (re-shred + re-match) through the existing pipeline.
// The client cross-reference is free — the standing client-match cron already re-scores every grant
// against active clients. It edits NONE of the six protected files (calls the exported runPipeline).
//
// Schedule: "45 12 * * 1" (vercel.json) = Mondays 12:45 UTC = 07:45 CDT / 06:45 CST — staggered a
// quarter-hour after the AR scraper cron. Vercel crons run only against PRODUCTION; to exercise a run
// on preview or ad hoc, drive runMonitor from a script or the admin surface.
//
// Auth: Bearer CRON_SECRET (cronDeny, fail-closed in prod). Service-role client (RLS-bypass +
// cache:"no-store", enforced in createServiceClient). DEFAULT OFF (AR_STATE_MONITOR_ENABLED): inert —
// no fetch, no diff, no re-derive — until the seed is verified and the flag is flipped.

import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/server";
import { cronDeny } from "@/lib/cron/auth";
import { arStateMonitorEnabled, runMonitor } from "@/lib/ar-state/monitor";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 300;

export async function GET(req: NextRequest) {
  const deny = cronDeny(req);
  if (deny) return deny;

  if (!arStateMonitorEnabled()) {
    return NextResponse.json({ disabled: true, reason: "AR_STATE_MONITOR_ENABLED not set" });
  }

  try {
    const report = await runMonitor(createServiceClient());
    return NextResponse.json({ ok: true, ...report });
  } catch (err) {
    console.error("AR-state monitor failed:", err instanceof Error ? err.message : err);
    return NextResponse.json({ error: "AR-state monitor failed" }, { status: 500 });
  }
}
