// Client one-time-match queue drain — runs on the Vercel Cron schedule.
//
// Drains prospects enqueued at initial_match_status='queued' (createClientAction),
// scoring each against the grant pool pair-by-pair, resumably, within a time
// budget under the 300s cap. See lib/clients/match-queue.ts. This is the mirror of
// /api/cron/match (which drains the grant-centric queue); kept separate so each
// has its own budget and neither starves the other.
//
// Auth: Bearer CRON_SECRET (cronDeny, fail-closed in prod) -- same as the other
// cron routes. Vercel crons run only against PRODUCTION; to drain on a preview use
// the admin-session route GET /api/clients/drain-match-queue. Both call the same
// drainClientMatchQueue.

import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/server";
import { cronDeny } from "@/lib/cron/auth";
import { drainClientMatchQueue } from "@/lib/clients/match-queue";
import { anyClientMatchPending } from "@/lib/clients/match-queue-guard";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function GET(req: NextRequest) {
  const deny = cronDeny(req);
  if (deny) return deny;

  const db = createServiceClient();

  // Fast-path: skip the drain (and its ~2.4s whole-pool load) when nothing is queued.
  // The queue is empty on almost every 10-min tick, and the drain loads the entire
  // grant pool BEFORE it checks for a claimable client, so an empty tick would scan
  // the corpus for nothing -- the platform's single biggest wasted recurring query.
  // A real enqueue is never skipped (see anyClientMatchPending), so this only removes
  // the no-op work.
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
