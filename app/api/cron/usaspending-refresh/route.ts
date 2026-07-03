// Monthly USASpending cache refresh — runs on a Vercel Cron schedule.
//
// Keeps each client's stored usaspending_summary fresh so matching never calls
// USASpending live. Bounded + idempotent by construction:
//  - Only clients that are stale (checked_at null or older than STALE_DAYS) and
//    not federal_history_verified (human-authoritative -> never overwritten).
//  - PER_RUN_CAP per invocation so a run fits maxDuration; the rest drain on the
//    next run. Re-running within the month re-fetches nothing already-fresh.
//  - refreshClientUSASpending writes ONLY on a verified result and does not
//    advance checked_at on failure, so a failed client retries next sweep and a
//    transient USASpending outage never corrupts or "uses up" a client.
//  - Batches of 5 (parity with matching) to stay gentle on the free API.
//
// Also the post-deploy SEED: the first run backfills the whole roster (all null
// checked_at), a few CAP-sized runs apart if the roster exceeds the cap.

import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/server";
import { refreshClientUSASpending, type RefreshableClient } from "@/lib/grants/usaspending-refresh";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

const PER_RUN_CAP = 40;
const STALE_DAYS = 25;
const BATCH_SIZE = 5;

export async function GET(req: NextRequest) {
  const cronSecret = process.env.CRON_SECRET;
  if (cronSecret) {
    const authHeader = req.headers.get("authorization");
    if (authHeader !== `Bearer ${cronSecret}`) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
  }

  const db = createServiceClient();
  const cutoff = new Date(Date.now() - STALE_DAYS * 24 * 60 * 60 * 1000).toISOString();

  // Stale = never checked OR checked before the cutoff. Verified clients are
  // authoritative and excluded. ISO timestamps carry no commas, so they are safe
  // inside the PostgREST or() grammar.
  const { data: clients, error } = await db
    .from("clients")
    .select("id, name, usaspending_search_name, federal_history_verified")
    .eq("federal_history_verified", false)
    .or(`usaspending_checked_at.is.null,usaspending_checked_at.lt.${cutoff}`)
    .limit(PER_RUN_CAP);

  if (error) {
    console.error("USASpending sweep query failed:", error.message);
    return NextResponse.json({ error: "Sweep query failed" }, { status: 500 });
  }

  const roster = (clients ?? []) as RefreshableClient[];
  let refreshed = 0;
  let skippedOrFailed = 0;

  for (let i = 0; i < roster.length; i += BATCH_SIZE) {
    const batch = roster.slice(i, i + BATCH_SIZE);
    const results = await Promise.allSettled(
      batch.map((c) => refreshClientUSASpending(db, c)),
    );
    for (const r of results) {
      if (r.status === "fulfilled" && r.value) refreshed++;
      else skippedOrFailed++;
    }
  }

  const remaining = roster.length === PER_RUN_CAP;
  console.log(`USASpending sweep: refreshed ${refreshed}, skipped/failed ${skippedOrFailed}, more=${remaining}`);
  return NextResponse.json({ refreshed, skippedOrFailed, processed: roster.length, more: remaining });
}
