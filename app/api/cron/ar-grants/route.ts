// AR state/regional funding scraper — the WEEKLY cron.
//
// Separate from cron/ingest (grants.gov/Simpler): this watches the fixed AR source registry, detects
// new opportunities + deadline changes, and hands GRANT-type hits into the EXISTING shred+match
// pipeline (via the exported runPipeline, promote.ts). It edits NONE of the six protected files.
//
// Schedule: "30 12 * * 1" (vercel.json) = Mondays 12:30 UTC = 07:30 CDT / 06:30 CST. Vercel crons run
// only against PRODUCTION — to exercise a scan on a preview or ad hoc, use the admin route
// (app/api/admin/ar-grants: GET dry-run / POST run).
//
// Auth: Bearer CRON_SECRET (cronDeny, fail-closed in prod). Service-role client (RLS-bypass +
// cache:"no-store", enforced inside createServiceClient). Loans are recorded but never promoted;
// PDFs are flagged only.

import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/server";
import { cronDeny } from "@/lib/cron/auth";
import { arGrantsCronEnabled, runArGrantsScan } from "@/lib/ar-grants/run";
import { promoteOpportunity } from "@/lib/ar-grants/promote";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function GET(req: NextRequest) {
  const deny = cronDeny(req);
  if (deny) return deny;

  // Default OFF (AR_GRANTS_CRON_ENABLED). The automatic weekly run stays inert — no fetch, no scan,
  // no promotion — until a clean admin dry-run is approved and the flag is flipped. The admin route
  // is unaffected, so verification + manual runs still work while this is off.
  if (!arGrantsCronEnabled()) {
    return NextResponse.json({ disabled: true, reason: "AR_GRANTS_CRON_ENABLED not set" });
  }

  try {
    const report = await runArGrantsScan(createServiceClient(), {
      apply: true,
      promote: (db, ctx) => promoteOpportunity(db, ctx),
    });
    return NextResponse.json({ ok: true, ran_at: report.ran_at, totals: report.totals, sources: report.sources });
  } catch (err) {
    console.error("AR grants scan failed:", err instanceof Error ? err.message : err);
    return NextResponse.json({ error: "AR grants scan failed" }, { status: 500 });
  }
}
