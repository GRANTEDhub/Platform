// Auto-inline IntellEngine QA drain — runs on the Vercel Cron schedule (Step 3, PR 1).
//
// Polls for surfaced (grant, client) pending cards with no QA verdict yet and runs the Opus + web QA
// pass on a bounded, cost-capped batch, writing each verdict to card_intel_reviews. PROPOSAL-ONLY: it
// never re-scores or removes a card (never calls scoreGrantClientPair). Gated behind AUTO_INTEL_ENABLED
// (default OFF) — off, runAutoIntel returns immediately and this route is a no-op, byte-identical to
// today.
//
// Auth: Bearer CRON_SECRET (cronDeny, fail-closed in prod) — same as the other cron routes. The service
// client is non-cached (createServiceClient sets cache:no-store — the drain-cache incident rule), which
// matters here because the poller's stable-URL SELECTs must not be served stale.

import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/server";
import { cronDeny } from "@/lib/cron/auth";
import { runAutoIntel } from "@/lib/grants/intel-queue";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function GET(req: NextRequest) {
  const deny = cronDeny(req);
  if (deny) return deny;

  const db = createServiceClient();
  const result = await runAutoIntel(db);

  return NextResponse.json(result);
}
