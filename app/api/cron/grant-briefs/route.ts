// Hourly grant-brief backfill — generates the plain-language grants.description_brief
// (migration 0069) for grants that don't have one yet.
//
// Deliberately its OWN cron rather than a step in ingest: app/api/cron/ingest/route.ts and
// lib/grants/pipeline.ts are protected files, and a sweep is the better shape anyway --
// it backfills the existing corpus, not just newly ingested grants.
//
// Bounded + idempotent by construction:
//  - Claims only grants with description_brief is null, oldest first (partial index in
//    0069 keeps that an index scan as the unwritten set shrinks).
//  - PER_RUN_CAP per invocation so a run fits maxDuration; the rest drain next hour.
//  - sweepGrantBriefs writes ONLY a real result and never advances
//    description_brief_at on failure, so a transient Anthropic error retries and a
//    description too thin to paraphrase is simply skipped every time at no cost beyond
//    the claim query.
//
// Nothing depends on this having run: every reader falls back to grants.description when
// the brief is null, and the alert draft path calls ensureGrantBrief inline so the one
// client-facing artifact never waits on the sweep.

import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/server";
import { cronDeny } from "@/lib/cron/auth";
import { sweepGrantBriefs } from "@/lib/grants/brief";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

// One Sonnet call per grant at ~700 max_tokens. 25/hour drains a ~400-grant backlog in
// under a day and then idles at whatever ingest adds (a few dozen a day at most).
const PER_RUN_CAP = 25;

export async function GET(req: NextRequest) {
  const deny = cronDeny(req);
  if (deny) return deny;

  try {
    const result = await sweepGrantBriefs(createServiceClient(), { cap: PER_RUN_CAP });
    console.log(
      `[grant-briefs] written ${result.written}, skipped ${result.skipped}, processed ${result.processed}, more=${result.more}` +
        ` | parked ${result.parked}` +
        ` | requeue regenerated ${result.regenerated}, current ${result.retiredCurrent}, failed ${result.retiredFailed}`,
    );
    return NextResponse.json(result);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    console.error("[grant-briefs] sweep failed:", message);
    return NextResponse.json({ error: "Brief sweep failed" }, { status: 500 });
  }
}
