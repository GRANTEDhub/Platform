import { NextRequest, NextResponse } from "next/server";
import { waitUntil } from "@vercel/functions";
import { createClient, createServiceClient } from "@/lib/supabase/server";
import { runPipeline } from "@/lib/grants/pipeline";
import { extractSimplerGovOpportunityId, fetchFromSimplerGovAPI } from "@/lib/grants/engine";

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

  // Front-door Ledger dedup for Simpler opportunities, keyed on FON
  // (opportunity_number) -- the stable identifier the flip uses, robust to the
  // URL-format mismatch between a pasted human URL (/opportunities/<int>) and the
  // cron-stored source_url (/opportunity/<uuid>). We resolve the FON from the
  // Simpler API up front (one cheap call) and check the Ledger: an already-present
  // grant is NOT re-processed -- we return its id so the caller can open the
  // existing record (and re-shred/re-match from there if they still want).
  //
  // Simpler-URL-only: for raw-text pastes and non-Simpler URLs the FON is
  // unknowable before shredding, so they fall through to today's behavior. That
  // paste-path gap is a KNOWN LIMITATION (a future post-shred dedup could close
  // it); the ingest form copy does not imply pastes are deduped.
  if (url) {
    const oppId = extractSimplerGovOpportunityId(url);
    if (oppId) {
      try {
        const { extracted } = await fetchFromSimplerGovAPI(oppId);
        const fon = extracted.fon;
        if (fon) {
          const { data: existing } = await db
            .from("grants")
            .select("id")
            .eq("fon", fon)
            .order("ingested_at", { ascending: false })
            .limit(1);
          if (existing && existing.length > 0) {
            return NextResponse.json({ grantId: existing[0].id, alreadyExists: true });
          }
        }
      } catch (err) {
        // Resolve failed (API down / bad id) -- don't block ingest; fall through
        // to the normal pipeline, which surfaces any real error on the record.
        console.error("FON dedup resolve failed; proceeding with ingest:", err);
      }
    }
  }

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
      await db.from("grants").update({ status: "processing", processing_started_at: new Date().toISOString() }).eq("id", grantId);
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
