import { NextRequest, NextResponse } from "next/server";
import { waitUntil } from "@vercel/functions";
import { createClient, createServiceClient } from "@/lib/supabase/server";
import { runPipeline } from "@/lib/grants/pipeline";

export const maxDuration = 300;

// On-demand ingest: paste a grant URL or raw NOFO text and get the full shred +
// match run. Any signed-in user (admin or contractor) may ingest.
export async function POST(req: NextRequest) {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  }

  let body: { url?: string; rawText?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const { url, rawText } = body;
  if (!url && !rawText) {
    return NextResponse.json(
      { error: "Provide a grant URL or raw NOFO text" },
      { status: 400 },
    );
  }

  const db = createServiceClient();
  const sourceUrl = url || "manual-paste";

  // Re-ingesting the same opportunity URL must reuse its grant row, not spawn a
  // new one (which would fragment cards across duplicate grants). Raw-text
  // pastes share the "manual-paste" sentinel, so only dedup real URLs.
  let grantId: string | undefined;
  if (url) {
    const { data: existing } = await db
      .from("grants")
      .select("id")
      .eq("source_url", sourceUrl)
      .order("ingested_at", { ascending: false })
      .limit(1);
    if (existing && existing.length > 0) {
      grantId = existing[0].id;
      await db.from("grants").update({ status: "processing" }).eq("id", grantId);
    }
  }

  if (!grantId) {
    const { data: grantRow, error } = await db
      .from("grants")
      .insert({ source_url: sourceUrl, status: "processing" })
      .select("id")
      .single();
    if (error || !grantRow) {
      return NextResponse.json({ error: "Failed to create grant record" }, { status: 500 });
    }
    grantId = grantRow.id;
  }

  if (!grantId) {
    return NextResponse.json({ error: "Failed to resolve grant record" }, { status: 500 });
  }

  waitUntil(
    runPipeline(grantId, url, rawText, db).catch(async (err) => {
      console.error("Pipeline error for grant", grantId, err);
      await db
        .from("grants")
        .update({ status: "error", error_detail: String(err?.message ?? err).slice(0, 600) })
        .eq("id", grantId);
    }),
  );

  return NextResponse.json({ grantId }, { status: 202 });
}
