import { NextRequest, NextResponse } from "next/server";
import { createClient, createServiceClient } from "@/lib/supabase/server";
import { refreshClientProfileById } from "@/lib/clients/profile";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

// Stage 3 one-time backfill: populate clients.client_profile for existing records
// created before Stage 2's auto-populate (or whose refine failed). Admin-only,
// browser-openable, batched by an offset cursor; drive it by opening next_url
// until done:true. Idempotent -- already-profiled clients are skipped unless
// ?force=1 (which re-refines everyone, e.g. after a refiner/schema change).
//
// The target set is the FULL client list (stable, ordered by id) and we skip
// already-profiled rows INSIDE the loop -- NOT a `where client_profile is null`
// target, which would shrink as we populate and misalign the offset cursor. Same
// shape as /api/grants/backfill-program-awards.
//
// Read path: refreshClientProfileById is null-safe (a failed refine is caught,
// leaves the row null, retryable on re-run). One temp-0 Sonnet call per refined
// record. Nothing matcher-facing.
const BATCH = 10;

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

  // Full, stable, deterministically-ordered client list (clients AND leads). The
  // client_profile value rides along only for the skip check.
  const { data: rows } = await db
    .from("clients")
    .select("id, client_profile")
    .order("id", { ascending: true });
  const targets = (rows ?? []) as { id: string; client_profile: unknown }[];
  const total = targets.length;
  const slice = targets.slice(offset, offset + BATCH);

  const updated: string[] = [];
  const skipped: string[] = []; // already had a profile (only when !force)
  const errors: { id: string; error: string }[] = [];

  for (const row of slice) {
    if (!force && row.client_profile != null) {
      skipped.push(row.id);
      continue;
    }
    try {
      const ok = await refreshClientProfileById(db, row.id);
      if (ok) updated.push(row.id);
      else errors.push({ id: row.id, error: "refine did not write (see server logs)" });
    } catch (e) {
      errors.push({ id: row.id, error: String(e instanceof Error ? e.message : e).slice(0, 200) });
    }
  }

  const nextOffset = offset + slice.length;
  const done = nextOffset >= total;
  return NextResponse.json({
    candidates_total: total,
    batch: { offset, size: slice.length },
    counts: { updated: updated.length, skipped: skipped.length, errored: errors.length },
    updated,
    skipped,
    errors,
    remaining: Math.max(0, total - nextOffset),
    done,
    next_url: done
      ? null
      : `${req.nextUrl.origin}${req.nextUrl.pathname}?offset=${nextOffset}${force ? "&force=1" : ""}`,
  });
}
