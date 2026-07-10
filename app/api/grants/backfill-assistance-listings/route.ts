import { NextRequest, NextResponse } from "next/server";
import { createClient, createServiceClient } from "@/lib/supabase/server";
import { extractSimplerGovOpportunityId, fetchFromSimplerGovAPI } from "@/lib/grants/engine";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

// Admin-only BOUNDED backfill (#107 Part 1): populate `assistance_listings` for
// CLIENT-matched grants only -- the small set where the future award map is
// actually viewed. NOT a full-roster backfill; everything else captures its CFDA
// naturally on the next ingest/re-match.
//
// GET on purpose: this is triggered from the browser on the real app (admin
// session), where the preview-auth problem doesn't apply. Safe as a GET because
// it is admin-gated, bounded (BATCH per call), and IDEMPOTENT -- each grant is a
// single cheap Simpler fetch (no LLM, no re-shred) that re-sets the same value;
// already-populated grants are skipped so re-runs are cheap. Drive it by opening
// the returned `next_url` until `done: true`.
const BATCH = 50;

export async function GET(req: NextRequest) {
  // Admin gate (mirrors the add-client route). On prod the normal admin session
  // is valid, so this just works in the browser.
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  const { data: profile } = await supabase.from("profiles").select("role").eq("id", user.id).single();
  if (profile?.role !== "admin") return NextResponse.json({ error: "Admins only" }, { status: 403 });

  if (!process.env.SIMPLER_GOV_API_KEY) {
    return NextResponse.json({ error: "SIMPLER_GOV_API_KEY not set in this environment" }, { status: 500 });
  }

  const offset = Math.max(0, parseInt(req.nextUrl.searchParams.get("offset") ?? "0", 10) || 0);
  const db = createServiceClient();

  // Client-matched grant ids: any review_card that is NOT a prospect card (mirrors
  // gate.ts isClientCard -- card_type null or <> 'prospect' counts as a client card).
  const { data: cardRows } = await db
    .from("review_cards")
    .select("grant_id, card_type")
    .not("grant_id", "is", null)
    .or("card_type.is.null,card_type.neq.prospect");
  const ids = Array.from(
    new Set(((cardRows ?? []) as { grant_id: string | null }[]).map((r) => r.grant_id).filter(Boolean)),
  ) as string[];
  ids.sort(); // deterministic order so the offset cursor is stable across calls
  const total = ids.length;

  const slice = ids.slice(offset, offset + BATCH);
  const updated: string[] = [];
  const updated_empty: string[] = []; // fetched OK, but the program has no listings
  const already_had: string[] = []; // already populated -> skipped (idempotent re-run)
  const skipped_no_source: string[] = []; // manual-paste / non-Simpler -> can't resolve
  const errors: { id: string; error: string }[] = [];

  if (slice.length > 0) {
    const { data: grants } = await db
      .from("grants")
      .select("id, source_url, assistance_listings")
      .in("id", slice);
    const byId = new Map(
      ((grants ?? []) as { id: string; source_url: string | null; assistance_listings: unknown }[]).map((g) => [
        g.id,
        g,
      ]),
    );

    for (const id of slice) {
      const g = byId.get(id);
      if (!g) continue;
      if (g.assistance_listings != null) {
        already_had.push(id);
        continue;
      }
      const oppId = extractSimplerGovOpportunityId(g.source_url ?? "");
      if (!oppId) {
        skipped_no_source.push(id);
        continue;
      }
      try {
        const { extracted } = await fetchFromSimplerGovAPI(oppId);
        const listings = extracted.assistance_listings ?? [];
        await db.from("grants").update({ assistance_listings: listings }).eq("id", id);
        if (listings.length > 0) updated.push(id);
        else updated_empty.push(id);
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
      updated_empty: updated_empty.length,
      already_had: already_had.length,
      skipped_no_source: skipped_no_source.length,
      errors: errors.length,
    },
    updated,
    updated_empty,
    skipped_no_source,
    errors,
    remaining: Math.max(0, total - nextOffset),
    done,
    next_url: done ? null : `${req.nextUrl.origin}${req.nextUrl.pathname}?offset=${nextOffset}`,
  });
}
