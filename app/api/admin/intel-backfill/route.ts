import { NextRequest, NextResponse } from "next/server";
import { createClient, createServiceClient } from "@/lib/supabase/server";
import { autoIntelApplyEnabled, backfillBroadApply, type BackfillCardInfo } from "@/lib/grants/intel-queue";
import { appBaseUrl } from "@/lib/site-url";

export const maxDuration = 300;
export const dynamic = "force-dynamic";

// ONE-TIME BROAD backfill trigger (admin-only). The companion to flipping AUTO_INTEL_APPLY_BROAD: the flag
// only changes NEW demotes (the poller skips already-verdicted cards), so the inert grounded demotes already
// in card_intel_reviews are re-projected onto their cards by THIS route. It applies the broad rule directly
// (grounded + refute-clean) via backfillBroadApply — it can never apply a refute-unclean demote.
//
//   GET  → DRY-RUN (read-only): returns the refute-clean set it WOULD apply + the refute-unclean staff-flag
//          set, each with a console link, so staff can spot-check a card before committing. Writes nothing.
//   POST → APPLY: re-projects the refute-clean demotes. Body { limit?, cardId? } bounds the batch (cardId
//          applies just that one — the canary). Gated on AUTO_INTEL_APPLY (the master apply flag), same as
//          the manual Re-run route. Idempotent: a card whose override is already live is skipped.
//
// A GET (browser-openable) is safe because it is read-only; the WRITE is POST-only so a link scanner /
// prefetch can never trigger the backfill (the same GET-is-safe / POST-mutates discipline as /auth/confirm).

async function requireAdmin() {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { error: NextResponse.json({ error: "Not authenticated" }, { status: 401 }) };
  const { data: profile } = await supabase.from("profiles").select("role").eq("id", user.id).single();
  if (profile?.role !== "admin") return { error: NextResponse.json({ error: "Admins only" }, { status: 403 }) };
  return { error: null as null };
}

// Attach a staff console link to each card so the dry-run list is spot-checkable in one click.
function withLinks(rows: BackfillCardInfo[]) {
  const base = appBaseUrl();
  return rows.map((r) => ({ ...r, console: `${base}/review/${r.cardId}` }));
}

export async function GET() {
  const { error } = await requireAdmin();
  if (error) return error;

  const db = createServiceClient();
  const result = await backfillBroadApply(db, { apply: false });
  return NextResponse.json({
    dryRun: true,
    counts: {
      eligible: result.eligible.length,
      eligiblePending: result.eligible.filter((r) => !r.alreadyLive).length,
      staffFlag: result.staffFlag.length,
    },
    eligible: withLinks(result.eligible),
    staffFlag: withLinks(result.staffFlag),
  });
}

export async function POST(req: NextRequest) {
  const { error } = await requireAdmin();
  if (error) return error;

  // The master apply flag governs ALL card rewrites (auto drain, manual Re-run, and this backfill alike).
  if (!autoIntelApplyEnabled()) {
    return NextResponse.json({ error: "AUTO_INTEL_APPLY is off — no card rewrites." }, { status: 409 });
  }

  const body = (await req.json().catch(() => ({}))) as { limit?: number; cardId?: string };
  const limit = typeof body.limit === "number" && body.limit > 0 ? Math.floor(body.limit) : undefined;
  const cardId = typeof body.cardId === "string" && body.cardId ? body.cardId : undefined;

  const db = createServiceClient();
  const result = await backfillBroadApply(db, { apply: true, limit, cardId });
  return NextResponse.json({
    dryRun: false,
    appliedCount: result.applied.length,
    applied: result.applied,
    counts: {
      eligible: result.eligible.length,
      eligiblePending: result.eligible.filter((r) => !r.alreadyLive).length,
      staffFlag: result.staffFlag.length,
    },
  });
}
