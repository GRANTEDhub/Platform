import { NextRequest, NextResponse } from "next/server";
import { waitUntil } from "@vercel/functions";
import { createClient, createServiceClient } from "@/lib/supabase/server";
import { runMatching, runPipeline } from "@/lib/grants/pipeline";

export const maxDuration = 300;

// Admin-only: re-run a single grant.
//   default ({}):            re-MATCH only — re-score clients against the stored
//                            shred + ideal_applicant_profile (cheap, ~seconds).
//   { "reshred": true }:     re-SHRED — re-fetch the NOFO, rebuild the shred AND
//                            the ideal_applicant_profile (Stage A), then re-score
//                            (the full pipeline, ~minutes). Use this after a
//                            scoring/Stage-A change so the profile regenerates.
export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
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

  const body = (await req.json().catch(() => ({}))) as { reshred?: boolean };
  const reshred = body.reshred === true;

  const db = createServiceClient();
  const { data: grant } = await db
    .from("grants")
    .select("id, is_domestic, source_url")
    .eq("id", params.id)
    .single();
  if (!grant) {
    return NextResponse.json({ error: "Grant not found" }, { status: 404 });
  }
  if (!grant.is_domestic) {
    return NextResponse.json(
      { error: "International grant — excluded from matching by policy" },
      { status: 400 },
    );
  }
  if (reshred && !grant.source_url) {
    return NextResponse.json(
      { error: "Cannot re-shred: this grant has no source URL to re-fetch" },
      { status: 400 },
    );
  }

  await db.from("grants").update({ status: "processing", processing_started_at: new Date().toISOString() }).eq("id", params.id);

  const work = reshred
    ? runPipeline(params.id, grant.source_url ?? undefined, undefined, db)
    : runMatching(params.id, db);

  waitUntil(
    work.catch(async (err) => {
      console.error(`${reshred ? "Re-shred" : "Re-match"} error for grant`, params.id, err);
      await db
        .from("grants")
        .update({ status: "error", error_detail: String(err?.message ?? err).slice(0, 600) })
        .eq("id", params.id);
    }),
  );

  return NextResponse.json({ ok: true, mode: reshred ? "reshred" : "rematch" }, { status: 202 });
}
