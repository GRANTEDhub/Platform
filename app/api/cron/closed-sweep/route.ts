// Closed-grant auto-archive sweep — runs on a Vercel Cron schedule.
//
// A grant whose submission deadline has strictly passed is dead: it must not keep sitting in a
// client's (or staff's) LIVE Grant Report looking like a live opportunity. This sweep moves every
// such pending card to the reversible "Passed" bucket, across ALL clients, with the honest reason
// ("Closed before review" / "Deadline passed after release"). The verdict paragraph already
// hard-kills these on the detail; this stops them surfacing as live in the list at all.
//
// include_released: TRUE here (unlike the staff manual bulk button, which is false). A dead grant
// should not sit in a live list regardless of whether the client saw it while open — the deliberate
// policy set for the automatic path. The single write shape + the strict `< 0` / fail-open
// eligibility live in lib/report/closed-sweep, shared with the manual route, so they cannot drift.
//
// NO calibration signal, ever (a missed deadline is capacity, not a scorer error). NEVER-HIDE: a
// swept card is reachable + reversible in "Passed", not deleted. decided_by is null (no user in a
// cron); decided_by_actor "staff".
//
// Flag CLOSED_SWEEP_ENABLED (default OFF): off is byte-identical — returns before any query, reads
// and writes nothing. Flipping it is a Vercel env change + redeploy, not a live toggle. The staff
// manual archive button and the admin backfill route are unaffected by the flag.
//
// Auth: Bearer CRON_SECRET (cronDeny, fail-closed in prod). Vercel crons run only against
// PRODUCTION — to exercise the sweep on a preview, use the admin route (app/api/admin/closed-sweep).

import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/server";
import { cronDeny } from "@/lib/cron/auth";
import { closedSweepEnabled, runClosedSweep } from "@/lib/report/closed-sweep";

export const dynamic = "force-dynamic";

// Cap on cards WRITTEN per run, so a large first backlog can't blow the function budget; the
// remainder is caught on the next hourly tick (most-overdue first). Steady-state is a handful/run.
const CAP = 200;

export async function GET(req: NextRequest) {
  const deny = cronDeny(req);
  if (deny) return deny;

  // OFF is inert: no query, no write, byte-identical to before this route existed.
  if (!closedSweepEnabled()) {
    return NextResponse.json({ disabled: true, archived: 0 });
  }

  try {
    const result = await runClosedSweep(createServiceClient(), {
      includeReleased: true,
      apply: true,
      limit: CAP,
      decidedBy: null,
    });
    return NextResponse.json({
      archived: result.archived,
      eligible: result.eligible,
      remaining: result.remaining,
      byReason: result.byReason,
    });
  } catch (err) {
    console.error(String(err instanceof Error ? err.message : err));
    return NextResponse.json({ error: "Closed sweep failed" }, { status: 500 });
  }
}
