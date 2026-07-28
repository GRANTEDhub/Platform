import { NextRequest, NextResponse } from "next/server";
import { createClient, createServiceClient } from "@/lib/supabase/server";
import { refreshClientCommunityContextById } from "@/lib/clients/profile";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

// One-time backfill: attach U.S. Census ACS community need-context to existing clients'
// client_profile, WITHOUT re-running the LLM distillation. Admin-only, browser-openable,
// batched by an offset cursor -- drive it by opening next_url until done:true.
//
// Only clients that ALREADY have a client_profile are eligible (community context is read
// only when a profile is present). Idempotent: skips clients that already carry a
// community_context unless ?force=1 (recompute everyone, e.g. after an ACS vintage bump).
// Mirrors /api/clients/backfill-profiles: the target set is the FULL client list (stable,
// ordered by id) with the skip check applied INSIDE the loop so the offset cursor stays
// aligned as rows populate. Cheap per record (one Census call + a jsonb patch), so a
// larger batch than the profile backfill.
const BATCH = 25;

export async function GET(req: NextRequest) {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  const { data: profile } = await supabase
    .from("profiles")
    .select("role")
    .eq("id", user.id)
    .single();
  if (profile?.role !== "admin") return NextResponse.json({ error: "Admins only" }, { status: 403 });

  const offset = Math.max(0, parseInt(req.nextUrl.searchParams.get("offset") ?? "0", 10) || 0);
  const force = req.nextUrl.searchParams.get("force") === "1";
  const db = createServiceClient();

  // Full, stable, deterministically-ordered client list. client_profile rides along for
  // the two skip checks (no profile -> ineligible; already has context -> skip unless force).
  const { data: rows } = await db
    .from("clients")
    .select("id, client_profile")
    .order("id", { ascending: true });
  const targets = (rows ?? []) as { id: string; client_profile: { community_context?: unknown } | null }[];
  const total = targets.length;
  const slice = targets.slice(offset, offset + BATCH);

  const updated: string[] = [];
  const skipped: string[] = []; // no profile yet, or already has context (unless force)
  const noContext: string[] = []; // has a profile but location did not resolve
  const errors: { id: string; error: string }[] = [];

  for (const row of slice) {
    if (row.client_profile == null) {
      skipped.push(row.id); // no profile -> community context is not read anyway
      continue;
    }
    if (!force && row.client_profile.community_context != null) {
      skipped.push(row.id);
      continue;
    }
    try {
      const result = await refreshClientCommunityContextById(db, row.id);
      if (result === "updated") updated.push(row.id);
      else if (result === "no-context") noContext.push(row.id);
      else if (result === "no-profile") skipped.push(row.id);
      else errors.push({ id: row.id, error: "write failed (see server logs)" });
    } catch (e) {
      errors.push({ id: row.id, error: String(e instanceof Error ? e.message : e).slice(0, 200) });
    }
  }

  const nextOffset = offset + slice.length;
  const done = nextOffset >= total;
  return NextResponse.json({
    candidates_total: total,
    batch: { offset, size: slice.length },
    counts: {
      updated: updated.length,
      skipped: skipped.length,
      no_context: noContext.length,
      errored: errors.length,
    },
    updated,
    skipped,
    no_context: noContext,
    errors,
    remaining: Math.max(0, total - nextOffset),
    done,
    next_url: done
      ? null
      : `${req.nextUrl.origin}${req.nextUrl.pathname}?offset=${nextOffset}${force ? "&force=1" : ""}`,
  });
}
