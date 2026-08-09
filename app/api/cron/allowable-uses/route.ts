// Hourly allowable-uses backfill — fills grants.allowable_uses (migration 0072) for grants
// that don't have a list yet.
//
// ITS OWN CRON, NOT A PHASE OF /api/cron/grant-briefs. Sharing that route would mean sharing
// its 25-slot budget, and #311 is the record of what that costs: the brief sweep's phase 2
// was given `cap - claimed`, which is zero on every run where phase 1 fills the cap, so the
// backfill never started and the 0/0 in the log read as success rather than starvation. Two
// sweeps that can each saturate a cap belong on two budgets. It also keeps the cadences
// independent -- this one can be slowed or paused for the staff-only week without touching
// the briefs.
//
// Bounded + idempotent by construction:
//  - Claims only `allowable_uses is null` AND `attempts < 3`, oldest ingest first (the
//    partial index in 0072 matches that predicate exactly, cap included).
//  - PER_RUN_CAP per invocation so a run fits maxDuration; the rest drain next hour.
//  - A VERIFIED-EMPTY RESULT IS A WRITE. A NOFO with no allowable-costs section is a real
//    answer, so it is stored with its reason and leaves the claim window. Only a genuine
//    failure (API error, no tool call) leaves the column null to be retried, and the
//    three-attempt cap parks a row that can never generate.
//
// Nothing depends on this having run: every reader falls back to the "Ask our team" sentinel
// when the column is null, and no client surface shows it at all until
// ALLOWABLE_USES_CLIENT_VISIBLE is turned on.

import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/server";
import { cronDeny } from "@/lib/cron/auth";
import { sweepAllowableUses } from "@/lib/grants/allowable-uses";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

// One Sonnet call per grant at ~2000 max_tokens with a ~14k-char excerpt -- heavier per row
// than the brief sweep, so the cap is lower. 15/hour drains a ~950-grant corpus in under
// three days and then idles at whatever ingest adds.
const PER_RUN_CAP = 15;

export async function GET(req: NextRequest) {
  const deny = cronDeny(req);
  if (deny) return deny;

  try {
    const r = await sweepAllowableUses(createServiceClient(), { cap: PER_RUN_CAP });
    // BOTH DROP RATES ON ONE LINE, for the staff-only week. quotes returned/kept is the gate
    // as it actually runs; "byte-exact would keep" is the counterfactual. The gap between
    // them is the cost of PDF extraction artifacts, isolated from model faithfulness -- which
    // is the number that decides whether normalization stays.
    console.log(
      `[allowable-uses] written ${r.written}, processed ${r.processed}, more=${r.more}` +
        ` | empty: no-section ${r.noSection}, no-raw-text ${r.noRawText}, all-dropped ${r.allDropped}` +
        ` | failed ${r.failed}, parked ${r.parked ?? "?"}` +
        ` | quotes returned ${r.quotesReturned}, kept ${r.quotesKept}` +
        ` (normalized) / ${r.quotesKeptStrict} (byte-exact)` +
        // The recut's own line, kept on the same log entry so one grep answers both "is the
        // gate healthy" and "is the better anchoring recovering the rows it was built for".
        ` | recut improved ${r.recutImproved}, still-empty ${r.recutStillEmpty},` +
        ` retired-short ${r.recutRetiredShort}, failed ${r.recutFailed}`,
    );
    return NextResponse.json(r);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    console.error("[allowable-uses] sweep failed:", message);
    return NextResponse.json({ error: "Allowable-uses sweep failed" }, { status: 500 });
  }
}
