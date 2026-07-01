// Scheduled ingestion — runs on a Vercel Cron schedule (0 1,8 * * *). Pulls
// posted + forecasted opportunities from Simpler.gov, deduplicates against what
// we already have, and runs the shred + match pipeline on anything new.
//
// Two searches per run:
//   - POSTED: date-windowed by post_date >= a forward-only cursor (the date of
//     our most recent import, minus a buffer), paginated to exhaustion, OLDEST
//     first. Oldest-first + the buffer make capping loss-free: any grants past
//     the per-run cap are NEWER than the cursor, so they stay in-window and
//     re-drain next run via dedup. No backfill of anything posted before we
//     started (forward-only).
//   - FORECASTED: no reliable post_date (pre-posting), so a date window can't
//     include them -- full-walk the (bounded) forecasted corpus and dedup.
//
// Concurrency is bounded: new grants are processed in small awaited batches
// (not a fire-and-forget fan-out), with a per-run cap so the run stays within
// maxDuration and under Simpler's rate limit (60/min). The remainder drains on
// the next run.
//
// NOTE: we filter only by opportunity_status and narrow entities downstream in
// jsPreFilter (per client). Filtering by applicant_type at the API would require
// pinning an enum that can drift; a stale value 422s the whole search.

import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/server";
import { runPipeline } from "@/lib/grants/pipeline";

export const maxDuration = 300;

const SEARCH_URL = "https://api.simpler.grants.gov/v1/opportunities/search";
const PAGE_SIZE = 100; // documented max for result pages
const MAX_PAGES = 50; // safety ceiling (5000 records) so a bad loop can't run away
const BUFFER_DAYS = 2; // cursor lookback: covers date-granularity + deferred grants
const PER_RUN_CAP = 25; // bounded so batched processing fits maxDuration; rest drains next run
const BATCH_SIZE = 5; // concurrent pipelines per batch (mirrors runMatching)

type SortOrder = { order_by: string; sort_direction: "ascending" | "descending" };

// Paginate one filter to exhaustion; returns the opportunity ids (UUID preferred,
// falling back to the legacy integer id, matching the /opportunity/{id} URL).
async function searchAllPages(
  apiKey: string,
  filters: Record<string, unknown>,
  sort: SortOrder[],
): Promise<string[]> {
  const ids: string[] = [];
  for (let page = 1; page <= MAX_PAGES; page++) {
    const res = await fetch(SEARCH_URL, {
      method: "POST",
      headers: { "X-API-Key": apiKey, "Content-Type": "application/json" },
      body: JSON.stringify({
        filters,
        pagination: { page_offset: page, page_size: PAGE_SIZE, sort_order: sort },
      }),
    });
    if (!res.ok) {
      const text = await res.text();
      console.error("Simpler.gov search failed:", res.status, text);
      throw new Error(`Simpler.gov search HTTP ${res.status}`);
    }
    const json = await res.json();
    const data: Array<{ opportunity_id?: string; legacy_opportunity_id?: number | string }> =
      json.data ?? [];
    for (const o of data) {
      const id = String(o.opportunity_id ?? o.legacy_opportunity_id ?? "");
      if (id) ids.push(id);
    }
    if (data.length < PAGE_SIZE) break; // short page = last page
  }
  return ids;
}

const urlFor = (id: string) => `https://simpler.grants.gov/opportunity/${id}`;

export async function GET(req: NextRequest) {
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

  // Forward-only cursor: the date of our most recent import minus a buffer.
  // Schema-free (derived, no migration). First run's window is small because the
  // last import is recent, so we never reach back before go-live.
  const { data: latest } = await db
    .from("grants")
    .select("ingested_at")
    .order("ingested_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  const cursorMs =
    (latest?.ingested_at ? new Date(latest.ingested_at).getTime() : Date.now()) -
    BUFFER_DAYS * 86_400_000;
  const cursorDate = new Date(cursorMs).toISOString().slice(0, 10);

  // Two searches (see file header). Tag each id with the status it came from so
  // the pipeline can mark forecasted grants.
  let tagged: { id: string; status: "posted" | "forecasted" }[];
  try {
    const postedIds = await searchAllPages(
      apiKey,
      { opportunity_status: { one_of: ["posted"] }, post_date: { start_date: cursorDate } },
      [{ order_by: "post_date", sort_direction: "ascending" }],
    );
    const forecastedIds = await searchAllPages(
      apiKey,
      { opportunity_status: { one_of: ["forecasted"] } },
      [{ order_by: "post_date", sort_direction: "descending" }],
    );
    tagged = [
      ...postedIds.map((id) => ({ id, status: "posted" as const })),
      ...forecastedIds.map((id) => ({ id, status: "forecasted" as const })),
    ];
  } catch {
    return NextResponse.json({ error: "Simpler.gov search failed" }, { status: 502 });
  }

  // De-dupe within the pull (an id shouldn't appear twice, but be safe).
  const seenId = new Set<string>();
  tagged = tagged.filter((t) => (seenId.has(t.id) ? false : (seenId.add(t.id), true)));

  // De-dupe against grants we already have, chunked so the source_url IN-list
  // never overflows the query.
  const existingUrls = new Set<string>();
  for (let i = 0; i < tagged.length; i += 100) {
    const chunk = tagged.slice(i, i + 100);
    const { data: existing } = await db
      .from("grants")
      .select("source_url")
      .in("source_url", chunk.map((t) => urlFor(t.id)));
    (existing ?? []).forEach((g: { source_url: string | null }) => {
      if (g.source_url) existingUrls.add(g.source_url);
    });
  }
  const fresh = tagged.filter((t) => !existingUrls.has(urlFor(t.id)));

  console.log(
    `Cron ingest: ${tagged.length} pulled (cursor ${cursorDate}), ${fresh.length} new after dedup`,
  );
  if (fresh.length === 0) {
    return NextResponse.json({ message: "No new grants", pulled: tagged.length, processed: 0 });
  }

  // Bounded processing: cap per run (rest drains next run, loss-free via
  // oldest-first + buffer), in awaited batches of BATCH_SIZE.
  const toProcess = fresh.slice(0, PER_RUN_CAP);
  const deferred = fresh.length - toProcess.length;
  const launched: string[] = [];

  for (let i = 0; i < toProcess.length; i += BATCH_SIZE) {
    const batch = toProcess.slice(i, i + BATCH_SIZE);
    await Promise.all(
      batch.map(async (t) => {
        const sourceUrl = urlFor(t.id);
        const { data: grantRow, error } = await db
          .from("grants")
          .insert({ source_url: sourceUrl, status: "processing" })
          .select("id")
          .single();
        if (error || !grantRow) {
          console.error(`Failed to create grant record for ${t.id}:`, error);
          return;
        }
        launched.push(grantRow.id);
        try {
          await runPipeline(grantRow.id, sourceUrl, undefined, db, {
            opportunityStatus: t.status,
          });
        } catch (err) {
          console.error(`Cron pipeline error for grant ${grantRow.id}:`, err);
          await db
            .from("grants")
            .update({
              status: "error",
              error_detail: String(err instanceof Error ? err.message : err).slice(0, 600),
            })
            .eq("id", grantRow.id);
        }
      }),
    );
  }

  return NextResponse.json({
    message: `Processed ${launched.length} grant(s)${deferred > 0 ? `, ${deferred} deferred to next run` : ""}`,
    pulled: tagged.length,
    processed: launched.length,
    deferred,
    grantIds: launched,
  });
}
