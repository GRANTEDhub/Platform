// Scheduled ingestion — runs on a Vercel Cron schedule. Searches Simpler.gov
// for recently posted (domestic, federal) grants, deduplicates against what we
// already have, and runs the full shred + match pipeline on anything new.

import { NextRequest, NextResponse } from "next/server";
import { waitUntil } from "@vercel/functions";
import { createServiceClient } from "@/lib/supabase/server";
import { runPipeline } from "@/lib/grants/pipeline";

export const maxDuration = 300;

// NOTE: we intentionally filter only by opportunity_status here and do entity
// narrowing downstream in jsPreFilter (per client). Filtering by applicant_type
// at the API would require pinning the exact enum vocabulary, which can drift;
// a stale value would 422 the whole search and silently break ingest. Pulling
// the most-recent posted opportunities and narrowing locally is more robust for
// a small roster. Re-introduce an applicant_type filter only after confirming
// the current allowed values against the live spec.

export async function GET(req: NextRequest) {
  // Verify this is Vercel Cron (or an authorized internal caller).
  const cronSecret = process.env.CRON_SECRET;
  if (cronSecret) {
    const authHeader = req.headers.get("authorization");
    if (authHeader !== `Bearer ${cronSecret}`) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
  }

  const apiKey = process.env.SIMPLER_GOV_API_KEY;
  if (!apiKey) {
    return NextResponse.json({ error: "Missing SIMPLER_GOV_API_KEY" }, { status: 500 });
  }

  const db = createServiceClient();

  let opportunityIds: string[] = [];
  try {
    const res = await fetch("https://api.simpler.grants.gov/v1/opportunities/search", {
      method: "POST",
      headers: { "X-API-Key": apiKey, "Content-Type": "application/json" },
      body: JSON.stringify({
        filters: {
          opportunity_status: { one_of: ["posted"] },
        },
        pagination: {
          page_offset: 1,
          page_size: 50,
          sort_by: "post_date",
          sort_direction: "descending",
        },
      }),
    });

    if (!res.ok) {
      const text = await res.text();
      console.error("Simpler.gov search failed:", res.status, text);
      return NextResponse.json({ error: `Simpler.gov search HTTP ${res.status}` }, { status: 502 });
    }

    const json = await res.json();
    const opportunities: Array<{ opportunity_id: number | string }> =
      json.data ?? json.results ?? [];
    opportunityIds = opportunities.map((o) => String(o.opportunity_id));
  } catch (err) {
    console.error("Simpler.gov search error:", err);
    return NextResponse.json({ error: "Simpler.gov search failed" }, { status: 502 });
  }

  if (opportunityIds.length === 0) {
    return NextResponse.json({ message: "No new grants found", processed: 0 });
  }

  // Deduplicate: skip any opportunity already in the grants table.
  const existingUrls = new Set<string>();
  const { data: existingGrants } = await db
    .from("grants")
    .select("source_url")
    .in(
      "source_url",
      opportunityIds.map((id) => `https://simpler.grants.gov/opportunities/${id}`),
    );
  (existingGrants ?? []).forEach((g: { source_url: string | null }) => {
    if (g.source_url) existingUrls.add(g.source_url);
  });

  const newIds = opportunityIds.filter(
    (id) => !existingUrls.has(`https://simpler.grants.gov/opportunities/${id}`),
  );

  console.log(`Cron ingest: ${opportunityIds.length} found, ${newIds.length} new after dedup`);

  if (newIds.length === 0) {
    return NextResponse.json({ message: "All grants already ingested", processed: 0 });
  }

  const launched: string[] = [];
  for (const opportunityId of newIds) {
    const sourceUrl = `https://simpler.grants.gov/opportunities/${opportunityId}`;
    const { data: grantRow, error } = await db
      .from("grants")
      .insert({ source_url: sourceUrl, status: "processing" })
      .select("id")
      .single();

    if (error || !grantRow) {
      console.error(`Failed to create grant record for ${opportunityId}:`, error);
      continue;
    }

    const grantId: string = grantRow.id;
    launched.push(grantId);

    waitUntil(
      runPipeline(grantId, sourceUrl, undefined, db).catch(async (err) => {
        console.error(`Cron pipeline error for grant ${grantId}:`, err);
        await db.from("grants").update({ status: "error" }).eq("id", grantId);
      }),
    );
  }

  return NextResponse.json({
    message: `Launched ${launched.length} pipeline(s)`,
    processed: launched.length,
    grantIds: launched,
  });
}
