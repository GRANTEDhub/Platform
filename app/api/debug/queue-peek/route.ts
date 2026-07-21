import { NextRequest, NextResponse } from "next/server";
import { createClient, createServiceClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

// TEMPORARY diagnostic — DELETE after diagnosis.
//
// The match drain (drainMatchQueue) reports queueEmpty:true even though Platform
// holds a large status='queued' backlog. Env/URL/service-role are already ruled
// out (the ingest cron reads AND writes Platform with this same createServiceClient).
// The drain and the watchdog both DESTRUCTURE ONLY `data` on their status=eq.queued
// query and treat null as "empty" (queue.ts / watchdog.ts) — so if that query is
// erroring, the error is swallowed and we never see it.
//
// This route runs the EXACT drain candidate query (plus a count, a sample, and
// controls) with the same service-role client, in the same prod runtime, and
// returns each query's { data/count, error } verbatim. Admin-session gated so it's
// browser-openable while logged in (mirrors /api/grants/drain-match-queue and
// /api/grants/run-watchdog) — no cron wait needed. It only reads; it mutates nothing.
export async function GET(_req: NextRequest) {
  // Admin-session auth (same gate as the other admin diagnostic routes).
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

  const db = createServiceClient();

  // 1) The EXACT drain candidate query (queue.ts) — the one that comes back empty.
  const candidate = await db
    .from("grants")
    .select("id, source_url, shred_depth, grant_status, raw_text")
    .eq("status", "queued")
    .order("ingested_at", { ascending: true })
    .limit(1)
    .maybeSingle();

  // 2) Exact count of queued rows as the SERVICE client sees it (head:true = no body).
  const queuedCount = await db
    .from("grants")
    .select("id", { count: "exact", head: true })
    .eq("status", "queued");

  // 3) A few sample queued rows, minimal columns (no raw_text).
  const sample = await db
    .from("grants")
    .select("id, status, grant_status, ingested_at")
    .eq("status", "queued")
    .order("ingested_at", { ascending: true })
    .limit(3);

  // 4) Controls we KNOW work from the api logs — prove the client reads Platform.
  const matchingCount = await db
    .from("grants")
    .select("id", { count: "exact", head: true })
    .eq("status", "matching");
  const completeCount = await db
    .from("grants")
    .select("id", { count: "exact", head: true })
    .eq("status", "complete");
  const totalCount = await db.from("grants").select("id", { count: "exact", head: true });

  // Don't dump a 100k raw_text blob if the candidate ever returns a row — length only.
  const candidateData = candidate.data
    ? { ...candidate.data, raw_text: candidate.data.raw_text?.length ?? null }
    : null;

  return NextResponse.json({
    // Runtime env truth (no secrets): confirms which project + that the key is present.
    runtime: {
      supabaseUrl: process.env.NEXT_PUBLIC_SUPABASE_URL ?? null,
      serviceKeyPresent: !!process.env.SUPABASE_SERVICE_ROLE_KEY,
      serviceKeyLength: (process.env.SUPABASE_SERVICE_ROLE_KEY ?? "").length,
    },
    candidate: { data: candidateData, error: candidate.error },
    queuedCount: { count: queuedCount.count, error: queuedCount.error },
    sample: { data: sample.data, error: sample.error },
    controls: {
      matching: { count: matchingCount.count, error: matchingCount.error },
      complete: { count: completeCount.count, error: completeCount.error },
      total: { count: totalCount.count, error: totalCount.error },
    },
  });
}
