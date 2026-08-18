import { NextRequest, NextResponse } from "next/server";
import { createClient, createServiceClient } from "@/lib/supabase/server";
import { refreshClientProfileById } from "@/lib/clients/profile";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

// Stage 3 one-time backfill: populate clients.client_profile for existing records
// created before Stage 2's auto-populate (or whose refine failed). Admin-only,
// browser-openable, TIME-BUDGETED and resumed by an offset cursor; drive it by
// opening next_url until done:true. Idempotent -- already-profiled clients are
// skipped unless ?force=1 (which re-refines everyone, e.g. after a refiner/schema
// change or to refresh stale-dated profiles).
//
// The target set is the FULL client list (stable, ordered by id) and we skip
// already-profiled rows INSIDE the loop -- NOT a `where client_profile is null`
// target, which would shrink as we populate and misalign the offset cursor. Same
// shape as /api/grants/backfill-program-awards.
//
// Read path: refreshClientProfileById is null-safe (a failed refine is caught,
// leaves the row null, retryable on re-run). One temp-0 Sonnet call per refined
// record. Nothing matcher-facing.
//
// Wall-clock budget: stop claiming new clients well under maxDuration (300s) so the
// last in-flight distillation still finishes inside the function's lifetime. Each
// force=1 refine is one LLM call (tens of seconds), so a FIXED batch of 10 blew the
// 300s cap on a roster of document-heavy clients (504 FUNCTION_INVOCATION_TIMEOUT).
// Self-pacing by time -- the same pattern as the matching drain -- makes each request
// complete regardless of client weight, and `processed` (not a batch size) drives the
// cursor so a request always makes progress and never over-claims into a timeout.
const BUDGET_MS = 220_000;

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

  const startedAt = Date.now();
  const updated: string[] = [];
  const skipped: string[] = []; // already had a profile (only when !force)
  const errors: { id: string; error: string }[] = [];

  // Walk from the cursor, refining until the wall-clock budget is spent. Skips (already-
  // profiled rows when !force) are near-instant, so a run flies through them and spends the
  // budget on actual refines. `processed` -- not a fixed batch size -- drives the next cursor,
  // so a request always makes progress (one refine is far under the budget) and stops before
  // claiming a client it can't finish in time. Always does at least one row (the processed>0
  // guard), so it can never stall.
  let processed = 0;
  for (const row of targets.slice(offset)) {
    if (processed > 0 && Date.now() - startedAt > BUDGET_MS) break;
    processed++;
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

  const nextOffset = offset + processed;
  const done = nextOffset >= total;
  return NextResponse.json({
    candidates_total: total,
    batch: { offset, size: processed },
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
