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

  const db = createServiceClient();
  const { data: grant } = await db
    .from("grants")
    .select("id, title, funder, raw_text")
    .eq("id", grantId)
    .maybeSingle<AllowableUsesGrant>();
  if (!grant) return NextResponse.json({ error: "Grant not found" }, { status: 404 });

  const { ok, value } = await reextractAllowableUses(db, grant);
  if (!ok || !value) {
    // Transient model failure — nothing written, safe to retry.
    return NextResponse.json({ ok: false, grantId, title: grant.title, error: "Extraction failed, retry" }, { status: 502 });
  }

  return NextResponse.json({
    ok: true,
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
