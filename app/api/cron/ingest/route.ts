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
// Each pulled opportunity is classified against what we already hold, matched on
// FON (opportunity_number -- stable across the forecast->posted flip, unlike the
// opportunity_id UUID) with source_url as a fallback: NEW (ingest fresh), FLIP (a
// grant we hold as Forecasted is now posted -- re-shred + re-match the same row,
// preserving prior client decisions), or SKIP (already held in its status).
//
// Concurrency is bounded: NEW + FLIP work is processed in small awaited batches
// (not a fire-and-forget fan-out), with a per-run cap so the run stays within
// maxDuration and under Simpler's rate limit (60/min). The remainder drains on
// the next run.
//
// NOTE: we filter only by opportunity_status and narrow entities downstream in
// jsPreFilter (per client). Filtering by applicant_type at the API would require
// pinning an enum that can drift; a stale value 422s the whole search.

import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/server";
import { cronDeny } from "@/lib/cron/auth";
import { runPipeline } from "@/lib/grants/pipeline";

export const maxDuration = 300;

const SEARCH_URL = "https://api.simpler.grants.gov/v1/opportunities/search";
const PAGE_SIZE = 100; // documented max for result pages
const MAX_PAGES = 50; // safety ceiling (5000 records) so a bad loop can't run away
const BUFFER_DAYS = 2; // cursor lookback: covers date-granularity + deferred grants
const PER_RUN_CAP = 25; // bounded so batched processing fits maxDuration; rest drains next run
const BATCH_SIZE = 5; // concurrent pipelines per batch (mirrors runMatching)

type SortOrder = { order_by: string; sort_direction: "ascending" | "descending" };

// One pulled opportunity: the id (for the URL / re-fetch) plus the federal
// opportunity number (FON = opportunity_number). The FON is the STABLE identity
// across the forecast -> posted transition (the opportunity_id UUID is not
// guaranteed to survive the flip), so it -- not the URL -- is what the
// flip detector matches on.
type Pulled = { id: string; fon: string | null };

// Paginate one filter to exhaustion; returns each opportunity's id (UUID
// preferred, falling back to the legacy integer id, matching the
// /opportunity/{id} URL) and its opportunity_number (FON).
async function searchAllPages(
  apiKey: string,
  filters: Record<string, unknown>,
  sort: SortOrder[],
): Promise<Pulled[]> {
  const out: Pulled[] = [];
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
    const data: Array<{
      opportunity_id?: string;
      legacy_opportunity_id?: number | string;
      opportunity_number?: string | null;
    }> = json.data ?? [];
    for (const o of data) {
      const id = String(o.opportunity_id ?? o.legacy_opportunity_id ?? "");
      if (id) out.push({ id, fon: o.opportunity_number ?? null });
    }
    if (data.length < PAGE_SIZE) break; // short page = last page
  }
  return out;
}

const urlFor = (id: string) => `https://simpler.grants.gov/opportunity/${id}`;
// FON comparison key: same source on both sides (Simpler opportunity_number),
// but normalize defensively so trivial casing/whitespace can't miss a flip.
const fonKey = (fon: string | null | undefined) => (fon ?? "").trim().toUpperCase();

export async function GET(req: NextRequest) {
  const deny = cronDeny(req);
  if (deny) return deny;

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

  // Two searches (see file header). Tag each pulled opportunity with the status
  // it came from so we can mark forecasted grants and detect flips.
  let tagged: (Pulled & { status: "posted" | "forecasted" })[];
  try {
    const posted = await searchAllPages(
      apiKey,
      { opportunity_status: { one_of: ["posted"] }, post_date: { start_date: cursorDate } },
      [{ order_by: "post_date", sort_direction: "ascending" }],
    );
    const forecasted = await searchAllPages(
      apiKey,
      { opportunity_status: { one_of: ["forecasted"] } },
      [{ order_by: "post_date", sort_direction: "descending" }],
    );
    tagged = [
      ...posted.map((p) => ({ ...p, status: "posted" as const })),
      ...forecasted.map((p) => ({ ...p, status: "forecasted" as const })),
    ];
  } catch {
    return NextResponse.json({ error: "Simpler.gov search failed" }, { status: 502 });
  }

  // De-dupe within the pull by id (an id shouldn't appear twice, but be safe).
  const seenId = new Set<string>();
  tagged = tagged.filter((t) => (seenId.has(t.id) ? false : (seenId.add(t.id), true)));

  // Classify each pulled opportunity against what we already have, matching on
  // FON first (stable across forecast->posted) and source_url as a fallback for
  // rows with no stored FON:
  //   NEW  -> no grant with this FON/URL yet: ingest it fresh.
  //   FLIP -> we hold it as Forecasted and it's now posted: re-shred + re-match
  //           the SAME row (runMatching preserves already-decided client cards).
  //   SKIP -> we already hold it in its current status: nothing to do.
  // Fetch the matching existing grants (chunked so neither IN-list overflows).
  type ExistingGrant = {
    id: string;
    fon: string | null;
    source_url: string | null;
    grant_status: string | null;
  };
  const incomingFons = [...new Set(tagged.map((t) => t.fon).filter((f): f is string => !!f))];
  const incomingUrls = tagged.map((t) => urlFor(t.id));
  const existing: ExistingGrant[] = [];
  const fetchExisting = async (column: "fon" | "source_url", values: string[]) => {
    for (let i = 0; i < values.length; i += 100) {
      const { data } = await db
        .from("grants")
        .select("id, fon, source_url, grant_status")
        .in(column, values.slice(i, i + 100));
      existing.push(...((data ?? []) as ExistingGrant[]));
    }
  };
  await fetchExisting("fon", incomingFons);
  await fetchExisting("source_url", incomingUrls);

  const existingByFon = new Map<string, ExistingGrant>();
  const existingByUrl = new Map<string, ExistingGrant>();
  for (const g of existing) {
    if (g.fon) existingByFon.set(fonKey(g.fon), g);
    if (g.source_url) existingByUrl.set(g.source_url, g);
  }

  type NewWork = { kind: "new"; id: string; status: "posted" | "forecasted" };
  type FlipWork = { kind: "flip"; id: string; existingId: string };
  const news: NewWork[] = [];
  const flips: FlipWork[] = [];
  for (const t of tagged) {
    const match =
      (t.fon ? existingByFon.get(fonKey(t.fon)) : undefined) ?? existingByUrl.get(urlFor(t.id));
    if (!match) {
      news.push({ kind: "new", id: t.id, status: t.status });
    } else if (t.status === "posted" && match.grant_status === "Forecasted") {
      // The one transition we act on: a tracked forecast has gone live.
      flips.push({ kind: "flip", id: t.id, existingId: match.id });
    }
    // else: already held in its current status -> SKIP.
  }

  console.log(
    `Cron ingest: ${tagged.length} pulled (cursor ${cursorDate}), ${news.length} new, ${flips.length} flip(s) after classify`,
  );
  if (news.length === 0 && flips.length === 0) {
    return NextResponse.json({ message: "Nothing new", pulled: tagged.length, processed: 0 });
  }

  // Bounded processing: flips first (a freshly-live grant should re-match
  // promptly), then new grants (posted are oldest-first, so the per-run cap is
  // loss-free -- deferred items stay in-window / stay classified as flips and
  // drain next run). Both NEW and FLIP cost a full shred+match, so both count
  // against the cap, in awaited batches of BATCH_SIZE.
  const work: (NewWork | FlipWork)[] = [...flips, ...news];
  const toProcess = work.slice(0, PER_RUN_CAP);
  const deferred = work.length - toProcess.length;
  const processedIds: string[] = [];
  let newCount = 0;
  let flipCount = 0;

  for (let i = 0; i < toProcess.length; i += BATCH_SIZE) {
    const batch = toProcess.slice(i, i + BATCH_SIZE);
    await Promise.all(
      batch.map(async (w) => {
        const sourceUrl = urlFor(w.id);
        if (w.kind === "flip") {
          // Reuse the existing row: stamp the activation marker, point source_url
          // at the now-posted opportunity (the UUID may have changed), reset to
          // processing, then re-run the pipeline as posted. runPipeline flips
          // grant_status off Forecasted and runMatching preserves already-decided
          // client cards while matching newly-acquired clients fresh (v1).
          const { error } = await db
            .from("grants")
            .update({
              status: "processing",
              activated_from_forecast_at: new Date().toISOString(),
              source_url: sourceUrl,
              error_detail: null,
            })
            .eq("id", w.existingId);
          if (error) {
            console.error(`Failed to mark flip for grant ${w.existingId}:`, error);
            return;
          }
          try {
            await runPipeline(w.existingId, sourceUrl, undefined, db, {
              opportunityStatus: "posted",
            });
            processedIds.push(w.existingId);
            flipCount++;
          } catch (err) {
            console.error(`Cron flip pipeline error for grant ${w.existingId}:`, err);
            await db
              .from("grants")
              .update({
                status: "error",
                error_detail: String(err instanceof Error ? err.message : err).slice(0, 600),
              })
              .eq("id", w.existingId);
          }
          return;
        }
        // NEW: create the row, then shred + match.
        const { data: grantRow, error } = await db
          .from("grants")
          .insert({ source_url: sourceUrl, status: "processing" })
          .select("id")
          .single();
        if (error || !grantRow) {
          console.error(`Failed to create grant record for ${w.id}:`, error);
          return;
        }
        processedIds.push(grantRow.id);
        newCount++;
        try {
          await runPipeline(grantRow.id, sourceUrl, undefined, db, {
            opportunityStatus: w.status,
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
    message: `Processed ${processedIds.length} grant(s) (${newCount} new, ${flipCount} flipped)${deferred > 0 ? `, ${deferred} deferred to next run` : ""}`,
    pulled: tagged.length,
    processed: processedIds.length,
    new: newCount,
    flipped: flipCount,
    deferred,
    grantIds: processedIds,
  });
}
