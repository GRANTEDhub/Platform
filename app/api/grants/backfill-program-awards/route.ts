import { NextRequest, NextResponse } from "next/server";
import { createClient, createServiceClient } from "@/lib/supabase/server";
import {
  clientMatchedGrantIds,
  normalizeListings,
  refreshProgramAwards,
} from "@/lib/grants/program-awards";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

// Admin-only BOUNDED backfill (#107 Part 2): populate program_award_summary for
// client-matched grants that carry a CFDA -- the small set where the award map is
// viewed. Immediate population so we don't wait for the monthly cron to drain.
//
// GET on purpose (browser-openable on the real app, admin session valid there);
// admin-gated, batched, idempotent (skips already-populated unless ?force=1).
// Each grant is ~6 USASpending calls, so the batch is small; drive it by opening
// the returned next_url until done:true. The response includes a `sample` of the
// first refreshed grant's byState so you can confirm the recipient state_code +
// amount/count came through on live data.
const BATCH = 8;

export async function GET(req: NextRequest) {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  const { data: profile } = await supabase.from("profiles").select("role").eq("id", user.id).single();
  if (profile?.role !== "admin") return NextResponse.json({ error: "Admins only" }, { status: 403 });

  const offset = Math.max(0, parseInt(req.nextUrl.searchParams.get("offset") ?? "0", 10) || 0);
  const force = req.nextUrl.searchParams.get("force") === "1";
  const db = createServiceClient();

  // Target = client-matched grants that carry a CFDA, deterministically ordered.
  const clientIds = await clientMatchedGrantIds(db);
  let targets: string[] = [];
  if (clientIds.length > 0) {
    const { data: grants } = await db
      .from("grants")
      .select("id, assistance_listings")
      .in("id", clientIds)
      .not("assistance_listings", "is", null)
      .order("id", { ascending: true });
    targets = ((grants ?? []) as { id: string; assistance_listings: unknown }[])
      .filter((g) => normalizeListings(g.assistance_listings).length > 0)
      .map((g) => g.id);
  }
  const total = targets.length;
  const slice = targets.slice(offset, offset + BATCH);

  const updated: string[] = [];
  const skipped_empty: string[] = []; // fetched, program had no awards
  const already_had: string[] = [];
  const errors: { id: string; error: string }[] = [];
  let sample: unknown = null;

  if (slice.length > 0) {
    const { data: existing } = await db
      .from("grants")
      .select("id, program_award_summary")
      .in("id", slice);
    const populated = new Set(
      ((existing ?? []) as { id: string; program_award_summary: unknown }[])
        .filter((g) => g.program_award_summary != null)
        .map((g) => g.id),
    );

    for (const id of slice) {
      if (!force && populated.has(id)) {
        already_had.push(id);
        continue;
      }
      try {
        const r = await refreshProgramAwards(id, db);
        if (r.ok && r.states > 0) updated.push(id);
        else skipped_empty.push(id);
        if (sample == null && r.ok) {
          const { data: g } = await db
            .from("grants")
            .select("id, program_award_summary")
            .eq("id", id)
            .single<{ id: string; program_award_summary: Record<string, unknown> | null }>();
          const s = g?.program_award_summary;
          if (s) {
            sample = {
              grantId: id,
              cfdas: s.cfdas,
              timePeriod: s.timePeriod,
              totalAmount: s.totalAmount,
              totalAwardsFetched: s.totalAwardsFetched,
              awardsTruncated: s.awardsTruncated,
              byState_first3: Array.isArray(s.byState) ? s.byState.slice(0, 3) : null,
              topAwards_first2: Array.isArray(s.topAwards) ? s.topAwards.slice(0, 2) : null,
            };
          }
        }
      } catch (e) {
        errors.push({ id, error: String(e instanceof Error ? e.message : e) });
      }
    }
  }

  const nextOffset = offset + slice.length;
  const done = nextOffset >= total;
  return NextResponse.json({
    candidates_total: total,
    batch: { offset, size: slice.length },
    counts: {
      updated: updated.length,
      skipped_empty: skipped_empty.length,
      already_had: already_had.length,
      errors: errors.length,
    },
    updated,
    skipped_empty,
    errors,
    sample, // first refreshed grant's summary slice -> verify state_code/amount/count
    remaining: Math.max(0, total - nextOffset),
    done,
    next_url: done ? null : `${req.nextUrl.origin}${req.nextUrl.pathname}?offset=${nextOffset}`,
  });
}
