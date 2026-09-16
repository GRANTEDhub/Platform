// Structured-deadline backfill sweep — runs on a Vercel Cron schedule.
//
// A grant whose free-text submission_deadline resolves to a real date, but whose STRUCTURED `deadline`
// column is null (the protected ingest-time parseDeadline's naive `new Date()` choked on a
// prose-wrapped date), FAILS OPEN in the match-pool gate (grantLifecycle: null → open) and gets
// scored/surfaced as a live match — the AR-state "fake match" root. This sweep re-parses
// submission_deadline with the Phase-1 `nextDeadlineFrom` and writes the resolved date into `deadline`
// so the gate sees the real (past) date and the closed grant leaves the pool. Forward-fix at the data
// layer — the protected gate (match-queue.ts) and the protected writer (pipeline.ts) are untouched.
//
// FILL-NULL ONLY, WRITE-ON-RESOLVE, NEVER NULL-CLOBBER: only null-deadline grants are scanned, only a
// real resolved date is ever written, and an existing deadline (every federal date) is never touched.
// A rolling / undated / unparseable string stays null (fail-open — a rolling grant stays matchable).
//
// RECURRING, not one-shot: new grants keep arriving via the protected parseDeadline→null, so the sweep
// runs hourly to catch a newly-ingested closed grant before it lingers as a fake match. Once a grant's
// deadline is filled it is non-null → never re-scanned, so steady state is a handful of new rows/run.
//
// COMPLEMENTS closed-sweep: this stops closed grants ENTERING the pool (no new cards); closed-sweep
// archives closed CARDS already created. Separate modules, separate flags, separate kill-switches.
//
// Flag DEADLINE_BACKFILL_ENABLED (default OFF): off is byte-identical — returns before any query,
// reads and writes nothing. Flipping it is a Vercel env change + redeploy, not a live toggle. The
// admin dry-run/apply route is unaffected by the flag.
//
// Auth: Bearer CRON_SECRET (cronDeny, fail-closed in prod). Vercel crons run only against PRODUCTION —
// to exercise the sweep on a preview, use the admin route (app/api/admin/deadline-backfill).

import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/server";
import { cronDeny } from "@/lib/cron/auth";
import { deadlineBackfillEnabled, runDeadlineBackfill } from "@/lib/grants/deadline-backfill";

export const dynamic = "force-dynamic";

// Cap on rows WRITTEN per run, so a large first backlog can't blow the function budget; the remainder
// is caught on the next hourly tick (most-past first). Steady-state is a handful/run.
const CAP = 500;

export async function GET(req: NextRequest) {
  const deny = cronDeny(req);
  if (deny) return deny;

  // OFF is inert: no query, no write, byte-identical to before this route existed.
  if (!deadlineBackfillEnabled()) {
    return NextResponse.json({ disabled: true, written: 0 });
  }

  try {
    const result = await runDeadlineBackfill(createServiceClient(), { apply: true, limit: CAP });
    return NextResponse.json({
      written: result.written,
      resolvable: result.resolvable,
      remaining: result.remaining,
      byDirection: result.byDirection,
    });
  } catch (err) {
    console.error(String(err instanceof Error ? err.message : err));
    return NextResponse.json({ error: "Deadline backfill failed" }, { status: 500 });
  }
}
