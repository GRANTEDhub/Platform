// Matching-queue drain — runs on the Vercel Cron schedule (every 10 min).
//
// Drains grants parked at status='queued' one at a time, cradle-to-grave
// (shred -> profile -> full-roster match), sequentially until the queue is empty
// or a time budget under the 300s cap is reached. See lib/grants/queue.ts.
//
// Auth: Bearer CRON_SECRET (cronDeny, fail-closed in prod) -- same as the other
// cron routes. For an ON-DEMAND, browser-openable drain (e.g. to verify a
// manually-enqueued test grant while logged in as admin) use the admin-session
// route: GET /api/grants/drain-match-queue. Both call the same drainMatchQueue.

import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/server";
import { cronDeny } from "@/lib/cron/auth";
import { drainMatchQueue } from "@/lib/grants/queue";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function GET(req: NextRequest) {
  const deny = cronDeny(req);
  if (deny) return deny;

  const db = createServiceClient();
  const result = await drainMatchQueue(db);
  console.log("[match-drain]", JSON.stringify(result));

  return NextResponse.json({
    drained: result.processed.length,
    errored: result.errored.length,
    processed: result.processed,
    errors: result.errored,
    queueEmpty: result.queueEmpty,
    budgetExhausted: result.budgetExhausted,
  });
}
