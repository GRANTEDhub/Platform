import { NextRequest, NextResponse } from "next/server";
import { createClient, createServiceClient } from "@/lib/supabase/server";
import { normalizeListings, refreshProgramAwards } from "@/lib/grants/program-awards";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

// Lazy fetch-on-view (#107 Part 3): returns a grant's cached program_award_summary,
// fetching + caching it once if a CFDA-carrying grant hasn't been swept yet. Any
// signed-in user (the review page is admin + contractor). The map calls this only
// when the server-rendered summary is null; a populated grant never hits it.
export async function GET(_req: NextRequest, { params }: { params: { id: string } }) {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Not authenticated" }, { status: 401 });

  const db = createServiceClient();
  const { data: grant } = await db
    .from("grants")
    .select("id, assistance_listings, program_award_summary")
    .eq("id", params.id)
    .single<{ id: string; assistance_listings: unknown; program_award_summary: unknown }>();
  if (!grant) return NextResponse.json({ error: "Grant not found" }, { status: 404 });

  // Already cached -> return it.
  if (grant.program_award_summary != null) {
    return NextResponse.json({ summary: grant.program_award_summary });
  }
  // No CFDA -> nothing to fetch.
  if (normalizeListings(grant.assistance_listings).length === 0) {
    return NextResponse.json({ summary: null });
  }

  // Fetch + cache once, then return the fresh summary.
  try {
    await refreshProgramAwards(params.id, db);
  } catch (err) {
    console.error("program-awards lazy fetch failed for grant", params.id, err);
    return NextResponse.json({ error: "Fetch failed", summary: null }, { status: 502 });
  }
  const { data: fresh } = await db
    .from("grants")
    .select("program_award_summary")
    .eq("id", params.id)
    .single<{ program_award_summary: unknown }>();
  return NextResponse.json({ summary: fresh?.program_award_summary ?? null });
}
