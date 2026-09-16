import { NextRequest, NextResponse } from "next/server";
import { createClient, createServiceClient } from "@/lib/supabase/server";
import { runDeadlineBackfill } from "@/lib/grants/deadline-backfill";

export const maxDuration = 300;
export const dynamic = "force-dynamic";

// Admin trigger for the structured-deadline backfill sweep — the "look before you flip" dry-run + the
// controlled first pass that pairs with enabling DEADLINE_BACKFILL_ENABLED on the cron.
//
//   GET  → DRY-RUN (read-only): how many null-deadline grants WOULD get a date written, split into
//          past (the fake-match fixes — these drop out of the match pool) vs future (a no-op for the
//          gate today, but they'll expire correctly later), plus how many correctly STAY null
//          (rolling/undated) and a most-past-first sample to spot-check. Writes nothing.
//   POST → APPLY (capped): fills `deadline` for the resolvable null-deadline grants. Body { limit? }
//          bounds the batch (most-past first; the rest wait for the next call/cron tick).
//
// Fill-null only, write-on-resolve, never null-clobber (a null result is never written; an existing
// deadline is never touched). Admin-only. GET (browser-openable) is safe because it is read-only; the
// WRITE is POST-only so a link scanner / prefetch can never trigger it — the same GET-is-safe /
// POST-mutates discipline as the closed-sweep + intel backfill routes. Unlike the cron, this route is
// NOT gated on DEADLINE_BACKFILL_ENABLED: it is the deliberate manual tool for the controlled first
// pass before the flag is flipped.

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

export async function GET() {
  const { error } = await requireAdmin();
  if (error) return error;

  const result = await runDeadlineBackfill(createServiceClient(), { apply: false });
  return NextResponse.json({
    dryRun: true,
    scanned: result.scanned, // null-deadline grants read
    resolvable: result.resolvable, // would-write
    staleNull: result.staleNull, // correctly left null (the guardrail count)
    byDirection: result.byDirection, // { past, future } — past = the fake-match fixes
    nullClobbers: 0, // structural: a null result is never a candidate, so this is always 0
    sample: result.sample, // most-past first: id, title, submissionDeadline, resolved, past
  });
}

export async function POST(req: NextRequest) {
  const { error } = await requireAdmin();
  if (error) return error;

  const body = (await req.json().catch(() => ({}))) as { limit?: number };
  // Distinguish an explicit 0 (write NOTHING — a safe zero-cap smoke test) from absent (no cap). A
  // falsy `> 0` check would coerce {limit:0} to undefined, which runDeadlineBackfill reads as "no cap"
  // and writes the FULL set — the opposite of the intent. applyDeadlineBackfill clamps with
  // Math.max(0, …), so passing 0 straight through correctly writes none.
  const limit = typeof body.limit === "number" && body.limit >= 0 ? Math.floor(body.limit) : undefined;

  const result = await runDeadlineBackfill(createServiceClient(), { apply: true, limit });
  return NextResponse.json({
    dryRun: false,
    written: result.written,
    remaining: result.remaining,
    resolvable: result.resolvable,
    byDirection: result.byDirection,
  });
}
