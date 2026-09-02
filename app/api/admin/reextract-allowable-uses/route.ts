import { NextRequest, NextResponse } from "next/server";
import { createClient, createServiceClient } from "@/lib/supabase/server";
import { reextractAllowableUses, type AllowableUsesGrant } from "@/lib/grants/allowable-uses";

export const runtime = "nodejs";
export const maxDuration = 60;
export const dynamic = "force-dynamic";

// Admin trigger: re-extract allowable / not-allowed uses for ONE grant on demand, right now, instead
// of waiting for the throttled hourly recut to reach it — the "I'm about to forward THIS grant,
// populate its use-of-funds first" bypass. Reuses the EXACT generate + save path the sweep runs
// (reextractAllowableUses), so the on-demand result is identical to what the recut would eventually
// produce; it stamps the current finder generation. POST-only (it writes and spends a model call, so
// a link scanner / prefetch can never trigger it) and admin-only — the same discipline as the closed-
// sweep / intel-backfill admin routes. Not flag-gated: it only fills the grant-level column (staff-
// visible always; client visibility is still governed separately by ALLOWABLE_USES_CLIENT_VISIBLE).
//
// REGRESSION-SAFE. Re-extraction is a nondeterministic model call, so re-running an already-populated
// grant can come back thinner. reextractAllowableUses HOLDS a shrink (returns saved:false) rather than
// clobbering a good list with a worse one; the response reports the counts so the admin can look, and
// { force: true } in the body overwrites deliberately after that look.
export async function POST(req: NextRequest) {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  const { data: profile } = await supabase.from("profiles").select("role").eq("id", user.id).single();
  if (profile?.role !== "admin") return NextResponse.json({ error: "Admins only" }, { status: 403 });

  const body = await req.json().catch(() => ({}) as Record<string, unknown>);
  const grantId = typeof body?.grantId === "string" ? body.grantId.trim() : "";
  if (!grantId) return NextResponse.json({ error: "grantId is required" }, { status: 400 });
  // Overwrite an already-populated list even if the fresh run is thinner. Off by default: a bare
  // re-extract HOLDS a regression and reports it; the admin re-sends with force after looking.
  const force = body?.force === true;

  const db = createServiceClient();
  const { data: grant, error: lookupError } = await db
    .from("grants")
    .select("id, title, funder, raw_text")
    .eq("id", grantId)
    .maybeSingle<AllowableUsesGrant>();
  if (lookupError) {
    // A transient DB / network fault is NOT a missing row -- surface it as retryable rather than
    // masking a recoverable infra fault as a permanent 404 that tells the admin the id is wrong.
    console.error(`[allowable-uses] reextract grant lookup failed grant=${grantId}: ${lookupError.message}`);
    return NextResponse.json({ ok: false, error: "Grant lookup failed, retry" }, { status: 502 });
  }
  if (!grant) return NextResponse.json({ error: "Grant not found" }, { status: 404 });

  const { ok, saved, value, previous, held } = await reextractAllowableUses(db, grant, { force });
  if (!ok || !value) {
    // Transient model failure — nothing written, safe to retry.
    return NextResponse.json({ ok: false, grantId, title: grant.title, error: "Extraction failed, retry" }, { status: 502 });
  }

  if (!saved && held === "regression") {
    // The fresh run came back THINNER than the good list already on the row — held, not saved, so a
    // nondeterministic re-run can't silently clobber a populated list (and stamp it out of recut reach).
    // 200, not an error: this is expected, deliberate behavior. Re-send with { force: true } to overwrite
    // after looking at both lists (the counts + the new list are returned here so the look is inline).
    return NextResponse.json({
      ok: true,
      saved: false,
      held: "regression",
      grantId,
      title: grant.title,
      message: `Held: re-extract produced ${value.items.length} item(s) but the stored list has ${previous?.items.length ?? 0}. Re-send with force:true to overwrite.`,
      previousItemCount: previous?.items.length ?? 0,
      newItemCount: value.items.length,
      // The would-be new lists so the admin can judge whether to force, without opening the console.
      allowed: value.items.filter((i) => i.kind !== "not_allowed").map((i) => i.line),
      notAllowed: value.items
        .filter((i) => i.kind === "not_allowed")
        .map((i) => ({ line: i.line, restriction_class: i.restriction_class })),
    });
  }

  return NextResponse.json({
    ok: true,
    saved: true,
    grantId,
    title: grant.title,
    reason: value.reason,
    itemCount: value.items.length,
    // The full extracted lists so the result is spot-checkable inline, without opening the console.
    allowed: value.items.filter((i) => i.kind !== "not_allowed").map((i) => i.line),
    notAllowed: value.items
      .filter((i) => i.kind === "not_allowed")
      .map((i) => ({ line: i.line, restriction_class: i.restriction_class })),
  });
}
