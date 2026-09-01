import { NextRequest, NextResponse } from "next/server";
import { createClient, createServiceClient } from "@/lib/supabase/server";
import { runClosedSweep, type EligibleCard } from "@/lib/report/closed-sweep";
import { appBaseUrl } from "@/lib/site-url";

export const maxDuration = 300;
export const dynamic = "force-dynamic";

// Admin trigger for the closed-grant auto-archive sweep — the "look before you flip" + one-time
// backlog clear that pairs with enabling CLOSED_SWEEP_ENABLED on the cron.
//
//   GET  → DRY-RUN (read-only): the count the first run WOULD archive, SPLIT into
//          "closed before review" vs "deadline passed after release" — the released split is the
//          sensitive one (cards a client was actively holding when the deadline ran out) — plus a
//          most-overdue-first sample with a console link per card to spot-check. Writes nothing.
//   POST → APPLY (capped): archives the eligible closed cards across all clients. Body { limit? }
//          bounds the batch (most-overdue first; the rest wait for the next call/cron tick).
//
// Both include_released=TRUE (the automatic policy: dead ≠ live regardless of release). Admin-only.
// A GET (browser-openable) is safe because it is read-only; the WRITE is POST-only so a link scanner
// / prefetch can never trigger the archive — the same GET-is-safe / POST-mutates discipline as the
// intel backfill. Unlike the cron, this route is NOT gated on CLOSED_SWEEP_ENABLED: it is the
// deliberate manual tool for the controlled first pass before the flag is flipped.

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

// A staff console link per sampled card so the dry-run list is spot-checkable in one click.
function withLinks(rows: EligibleCard[]) {
  const base = appBaseUrl();
  return rows.map((r) => ({ ...r, console: `${base}/review/${r.cardId}` }));
}

export async function GET() {
  const { error } = await requireAdmin();
  if (error) return error;

  const result = await runClosedSweep(createServiceClient(), { includeReleased: true, apply: false });
  return NextResponse.json({
    dryRun: true,
    scanned: result.scanned,
    eligible: result.eligible,
    byReason: result.byReason, // { closedBeforeReview, deadlinePassedAfterRelease }
    sample: withLinks(result.sample),
  });
}

export async function POST(req: NextRequest) {
  const { error } = await requireAdmin();
  if (error) return error;

  const body = (await req.json().catch(() => ({}))) as { limit?: number };
  const limit = typeof body.limit === "number" && body.limit > 0 ? Math.floor(body.limit) : undefined;

  const result = await runClosedSweep(createServiceClient(), {
    includeReleased: true,
    apply: true,
    limit,
    decidedBy: null,
  });
  return NextResponse.json({
    dryRun: false,
    archived: result.archived,
    remaining: result.remaining,
    eligible: result.eligible,
    byReason: result.byReason,
  });
}
