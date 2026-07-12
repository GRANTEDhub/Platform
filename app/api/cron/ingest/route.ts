// Scheduled ingestion — runs on a Vercel Cron schedule (0 1,8 * * *). Pulls
// posted + forecasted opportunities from Simpler.gov, deduplicates against what
// we already have, and ENQUEUES anything new for matching (status='queued').
// It does NOT shred or match here: the drain cron (/api/cron/match) processes
// the queue one grant at a time, cradle-to-grave, within its own 300s window.
// This is the Move 2 split -- discovery used to run the full pipeline inline for
// up to PER_RUN_CAP grants in THIS function and time out partway (silent partial
// matches). Discovery is now cheap (search + classify + DB writes, no LLM).
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
// A per-run cap bounds the enqueue writes; the remainder defers to the next run
// (loss-free -- see the POSTED note above). The Simpler search itself still
// respects the 60/min rate limit via paginated fetches.
//
// NOTE: we filter only by opportunity_status and narrow entities downstream in
// jsPreFilter (per client). Filtering by applicant_type at the API would require
// pinning an enum that can drift; a stale value 422s the whole search.

import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/server";
import { cronDeny } from "@/lib/cron/auth";

export const maxDuration = 300;

const SEARCH_URL = "https://api.simpler.grants.gov/v1/opportunities/search";
const PAGE_SIZE = 100; // documented max for result pages
const MAX_PAGES = 50; // safety ceiling (5000 records) so a bad loop can't run away
const BUFFER_DAYS = 2; // cursor lookback: covers date-granularity + deferred grants
const PER_RUN_CAP = 25; // bounds a run's enqueue writes; the rest defers, loss-free, to next run

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

  // Enqueue-only (Move 2): discovery does NO shred/match itself -- it parks work
  // in the matching queue (status='queued') and the drain cron (/api/cron/match)
  // processes one grant at a time, cradle-to-grave, within the 300s window. This
  // removes the old failure mode where up to PER_RUN_CAP full pipelines ran inside
  // THIS 300s function and timed out partway (silent partial matches).
  //
  // Flips first (a freshly-live grant should drain promptly -- the queue is
  // oldest-first and a flip's ingested_at is old). PER_RUN_CAP still bounds a
  // run's DB writes; posted are oldest-first, so deferred items stay in-window /
  // stay classified as flips and enqueue next run (loss-free).
  const work: (NewWork | FlipWork)[] = [...flips, ...news];
  const toEnqueue = work.slice(0, PER_RUN_CAP);
  const deferred = work.length - toEnqueue.length;
  const enqueuedIds: string[] = [];
  let newCount = 0;
  let flipCount = 0;

  // Cheap DB writes only (no LLM / external calls), so a simple sequential loop
  // is plenty -- no batching needed now that the pipeline runs off in the drain.
  for (const w of toEnqueue) {
    const sourceUrl = urlFor(w.id);
    if (w.kind === "flip") {
      // A tracked forecast has gone live. Re-queue the EXISTING row for a full
      // re-shred + re-match by the drain: clear shred_depth (force the drain's
      // shred branch -> re-fetch the now-published NOFO), drop the Forecasted
      // marker (so the drain treats it as posted and matches it), reset the retry
      // budget, point source_url at the now-posted opportunity (the UUID may have
      // changed), and stamp the activation marker. runMatching still preserves
      // already-decided client cards on the re-match.
      const { error } = await db
        .from("grants")
        .update({
          status: "queued",
          grant_status: null,
          shred_depth: null,
          match_retry_count: 0,
          activated_from_forecast_at: new Date().toISOString(),
          source_url: sourceUrl,
          error_detail: null,
        })
        .eq("id", w.existingId);
      if (error) {
        console.error(`Failed to enqueue flip for grant ${w.existingId}:`, error);
        continue;
      }
      enqueuedIds.push(w.existingId);
      flipCount++;
      continue;
    }
    // NEW: create the row already queued. A forecasted opportunity carries the
    // Forecasted marker so the drain shreds-but-doesn't-match it (the drain derives
    // the authoritative 'forecasted' hint from grant_status); posted carries no
    // marker, so the drain shreds + matches it.
    const { data: grantRow, error } = await db
      .from("grants")
      .insert({
        source_url: sourceUrl,
        status: "queued",
        grant_status: w.status === "forecasted" ? "Forecasted" : null,
      })
      .select("id")
      .single();
    if (error || !grantRow) {
      console.error(`Failed to create grant record for ${w.id}:`, error);
      continue;
    }
    enqueuedIds.push(grantRow.id);
    newCount++;
  }

  return NextResponse.json({
    message: `Enqueued ${enqueuedIds.length} grant(s) for matching (${newCount} new, ${flipCount} flipped)${deferred > 0 ? `, ${deferred} deferred to next run` : ""}`,
    pulled: tagged.length,
    enqueued: enqueuedIds.length,
    new: newCount,
    flipped: flipCount,
    deferred,
    grantIds: enqueuedIds,
  });
}
