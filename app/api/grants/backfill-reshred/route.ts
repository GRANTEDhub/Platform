import { NextRequest, NextResponse } from "next/server";
import { waitUntil } from "@vercel/functions";
import { createClient, createServiceClient } from "@/lib/supabase/server";
import { runPipeline } from "@/lib/grants/pipeline";

export const maxDuration = 300;

// Admin-only ONE-TIME backfill: re-shred a bounded set of grants under the
// tightened extraction prompt (the mis-filed-hard_disqualifiers remediation).
//
// A re-shred is a full runPipeline (re-fetch NOFO + Stage A + full-roster match,
// ~minutes, run in the background via waitUntil), and each internally fans
// matching out 5-wide -- so running many at once would be a large uncontrolled
// LLM fan-out. Concurrency is held to <= max (default 2, hard cap 3): the route
// REFUSES to kick while any target grant is still 'processing'. Drive it by
// calling repeatedly with the same grantIds and an advancing offset until done.
//
// Deterministic by design: an explicit grantIds list + offset cursor, NOT a
// "grants with hard_disqualifiers" filter -- because a genuine-kill grant keeps
// its hard_disqualifiers after re-shred and would otherwise be reprocessed every
// call. The list is stable; the offset advances through it exactly once.
const DEFAULT_MAX = 2;
const HARD_CAP = 3;

export async function POST(req: NextRequest) {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  }
  const { data: profile } = await supabase
    .from("profiles")
    .select("role")
    .eq("id", user.id)
    .single();
  if (profile?.role !== "admin") {
    return NextResponse.json({ error: "Admins only" }, { status: 403 });
  }

  const body = (await req.json().catch(() => ({}))) as {
    grantIds?: string[];
    offset?: number;
    max?: number;
  };
  const grantIds = Array.isArray(body.grantIds) ? body.grantIds.filter(Boolean) : [];
  if (grantIds.length === 0) {
    return NextResponse.json({ error: "grantIds[] is required" }, { status: 400 });
  }
  const max = Math.min(Math.max(1, body.max ?? DEFAULT_MAX), HARD_CAP);
  const offset = Math.max(0, body.offset ?? 0);

  const db = createServiceClient();

  // Concurrency guard: never kick another batch while ANY target is still
  // processing -- caps concurrent re-shreds at `max`.
  const { data: inflightRows } = await db
    .from("grants")
    .select("id")
    .in("id", grantIds)
    .eq("status", "processing");
  const inFlight = (inflightRows ?? []).map((g) => g.id);
  if (inFlight.length > 0) {
    return NextResponse.json({
      kicked: [],
      inFlight,
      offset,
      message: "Target grants still processing — wait for them to finish, then retry this offset.",
    });
  }

  const slice = grantIds.slice(offset, offset + max);
  if (slice.length === 0) {
    return NextResponse.json({ kicked: [], done: true, message: "Backfill complete." });
  }

  const { data: rows } = await db.from("grants").select("id, source_url").in("id", slice);
  const byId = new Map((rows ?? []).map((g) => [g.id, g.source_url as string | null]));

  const kicked: string[] = [];
  const skipped_no_source: string[] = [];
  for (const id of slice) {
    if (!byId.has(id)) {
      console.error("backfill-reshred: grant not found", id);
      continue;
    }
    const sourceUrl = byId.get(id) ?? null;
    // Re-shred needs a re-fetchable source. A null (or the "manual-paste"
    // sentinel) source_url would make runPipeline extract from empty text and
    // DESTROY the grant's real data -- skip and report it, never clobber.
    // (Mirrors the Rebuild Grant Profile route's null-source guard.)
    if (!sourceUrl || sourceUrl === "manual-paste") {
      skipped_no_source.push(id);
      continue;
    }
    await db.from("grants").update({ status: "processing" }).eq("id", id);
    waitUntil(
      runPipeline(id, sourceUrl, undefined, db).catch(async (err) => {
        console.error("backfill-reshred pipeline error for grant", id, err);
        await db
          .from("grants")
          .update({ status: "error", error_detail: String(err?.message ?? err).slice(0, 600) })
          .eq("id", id);
      }),
    );
    kicked.push(id);
  }

  return NextResponse.json({
    kicked,
    skipped_no_source,
    nextOffset: offset + slice.length,
    remaining: Math.max(0, grantIds.length - (offset + slice.length)),
  });
}
