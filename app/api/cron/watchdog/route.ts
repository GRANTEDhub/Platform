// Stuck-pipeline watchdog — runs on a Vercel Cron schedule.
//
// The shred+score pipeline runs as fire-and-forget background work
// (waitUntil(runPipeline(...).catch(...))) on a function capped at 300s. That
// .catch only fires if the promise REJECTS; if the function is killed (timeout,
// OOM, instance recycle, deploy mid-run) the process dies and the grant is left
// status='processing' with a null error_detail, forever -- an invisible infinite
// spinner (observed 2026-06-27).
//
// This sweep flips any grant stuck in 'processing' past a generous threshold
// (15 min, comfortably above the 300s function cap) to a terminal 'error' the
// detail page already renders. Keyed off ingested_at -- accurate for the
// cron-inserted rows that are the real unattended risk. A manual re-ingest
// reuses an old row, so it could be flipped prematurely, but that self-corrects:
// the still-running pipeline overwrites status to 'complete' on success, and a
// human is watching that re-ingest anyway.

import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/server";
import { cronDeny } from "@/lib/cron/auth";

export const dynamic = "force-dynamic";

const STUCK_THRESHOLD_MINUTES = 15;

export async function GET(req: NextRequest) {
  const deny = cronDeny(req);
  if (deny) return deny;

  const db = createServiceClient();
  const cutoff = new Date(Date.now() - STUCK_THRESHOLD_MINUTES * 60 * 1000).toISOString();

  const { data, error } = await db
    .from("grants")
    .update({
      status: "error",
      error_detail:
        "Stuck in processing (watchdog): pipeline did not complete -- the function likely timed out or was recycled. Re-ingest to retry.",
    })
    .eq("status", "processing")
    .lt("ingested_at", cutoff)
    .select("id");

  if (error) {
    console.error("Watchdog sweep failed:", error.message);
    return NextResponse.json({ error: "Watchdog sweep failed" }, { status: 500 });
  }

  const swept = data?.length ?? 0;
  if (swept > 0) {
    console.log(`Watchdog: flipped ${swept} stuck grant(s) to error`, data?.map((g) => g.id));
  }
  return NextResponse.json({ swept, grantIds: (data ?? []).map((g) => g.id) });
}
