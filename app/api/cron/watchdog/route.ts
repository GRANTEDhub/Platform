// Stuck-pipeline watchdog — runs on a Vercel Cron schedule.
//
// The shred+score pipeline runs as background work on a function capped at 300s.
// If the function is KILLED (timeout, OOM, instance recycle, deploy mid-run) the
// process dies with NO thrown error and the grant is left mid-flight forever --
// an invisible dead-end (observed 2026-06-27). This sweep turns every such dead
// state into a visible, recoverable one:
//   status='processing' -> a shred died. Flip to 'error' (no retry -- a human
//                          kicked it and re-runs in one click).
//   status='matching'   -> the matching-queue drain (Move 2) died mid-match, on
//                          the AUTOMATIC path nobody watches. Requeue up to
//                          MATCH_MAX_RETRIES (idempotent re-drain), then 'error'.
//   status='queued'      -> waiting, not stuck: never swept, but backlog is logged
//                          so a behind/down drain is never silent.
// Logic lives in lib/grants/watchdog.ts so the admin trigger
// (/api/grants/run-watchdog) runs the identical sweep on demand.
//
// Auth: Bearer CRON_SECRET (cronDeny, fail-closed in prod). Vercel crons run only
// against PRODUCTION -- to exercise the sweep on a preview, use the admin route.

import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/server";
import { cronDeny } from "@/lib/cron/auth";
import { runWatchdogSweep } from "@/lib/grants/watchdog";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const deny = cronDeny(req);
  if (deny) return deny;

  try {
    const result = await runWatchdogSweep(createServiceClient());
    return NextResponse.json(result);
  } catch (err) {
    console.error(String(err instanceof Error ? err.message : err));
    return NextResponse.json({ error: "Watchdog sweep failed" }, { status: 500 });
  }
}
