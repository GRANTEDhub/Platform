import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { waitUntil } from "@vercel/functions";
import { runPipeline } from "@/lib/grants/pipeline";
import { fetchWebsite } from "@/lib/net/fetch-website";
import { stripToText, type RawItem } from "@/lib/ar-grants/parse";
import { buildEligibilityPreamble, type Classified } from "@/lib/ar-grants/classify";
import { findGrantIdForItem } from "@/lib/ar-grants/store";
import type { ArGrantSource } from "@/lib/ar-grants/sources";

// The pipeline handoff — Seam 2. ONLY grant-type opportunities reach here (loans + PDFs are gated out
// upstream in run.ts, decision A). It reuses the EXISTING pipeline with ZERO protected-file edits:
// it imports the EXPORTED runPipeline and calls it; it never edits pipeline.ts/engine.ts.
//
// ── WHY SEAM 2 (insert + runPipeline) AND NOT A PLAIN status='queued' ENQUEUE ──
//
// The drain (queue.ts) re-fetches source_url and re-shreds, and the shred OVERWRITES
// geographic_eligibility / eligible_entity_types with whatever it reads off the page — which would
// erase the source's geo/elig tags on a page that states them only vaguely (the exact NWA-region /
// employer-only case decision B must not lose). So instead we SEED the shred input: rawText =
// authoritative eligibility preamble + the opportunity text, passed straight to runPipeline. The
// shredder extracts geographic_eligibility / eligible_entity_types FROM the preamble, so the existing
// matcher gates them (decision B — LLM-field enforcement). Mirrors the on-demand ingest route
// (app/api/grants/ingest), the proven non-protected insert+runPipeline pattern.
//
// Volume: weekly cadence, few new grants/run, promotion-capped in run.ts — the same low-volume shape
// the ingest route already runs this way. A run-interrupted promotion is left at status='processing'
// and recovered by the existing watchdog cron (a known edge: watchdog recovery re-shreds via the
// drain without the preamble, so a vague-page tag can be lost on that path — acceptable for v1).

const MAX_DETAIL_CHARS = 40_000;

export interface PromoteContext {
  source: ArGrantSource;
  item: RawItem;
  cls: Classified;
  itemId: string; // the ar_source_items row id (provenance link)
}

export interface PromoteDeps {
  fetchDetail?: (url: string) => Promise<string | null>;
  runPipelineImpl?: typeof runPipeline;
  schedule?: (p: Promise<unknown>) => void;
  now?: () => string;
}

// Pure: the columns of the grants stub we insert/update. Unit-tested without a DB.
//   source_url  a real opportunity URL when we have one (dedup via the existing grants_source_url_uniq
//               index + provenance); a stable synthetic key for a list-only hit with no URL.
//   grant_status 'Forecasted' holds a not-yet-open program (the pipeline skips matching until it
//               posts — decision 5); otherwise left for the shred to set.
export function buildScrapedGrantInsert(ctx: PromoteContext): {
  source_url: string;
  title: string;
  ar_source_item_id: string;
  grant_status: string | null;
} {
  return {
    source_url: ctx.item.url ?? `arsrc:${ctx.source.agency}:${ctx.itemId}`,
    title: ctx.item.title.slice(0, 500),
    ar_source_item_id: ctx.itemId,
    grant_status: ctx.cls.forecasted ? "Forecasted" : null,
  };
}

async function defaultFetchDetail(url: string): Promise<string | null> {
  const res = await fetchWebsite(url);
  if (!res.ok) return null;
  return stripToText(res.html).slice(0, MAX_DETAIL_CHARS);
}

// Promote one grant-type opportunity into the pipeline. Returns the grants row id + whether it was a
// fresh insert or a re-queue of an already-promoted item (decision 6 — a detected change re-runs the
// same Seam 2 on the existing row, re-shredding with the preamble and re-matching).
export async function promoteOpportunity(
  db: SupabaseClient,
  ctx: PromoteContext,
  deps: PromoteDeps = {},
): Promise<{ grantId: string; action: "inserted" | "requeued" } | { grantId: null; action: "failed" }> {
  const fetchDetail = deps.fetchDetail ?? defaultFetchDetail;
  const pipeline = deps.runPipelineImpl ?? runPipeline;
  const schedule = deps.schedule ?? ((p) => waitUntil(p));
  const now = deps.now ?? (() => new Date().toISOString());

  // Opportunity text for the shred: the detail page when fetchable, else the listing snippet we
  // already have (a JS-rendered / blocked detail page still yields a minimal shred, never a blank one).
  let detailText: string | null = null;
  if (ctx.item.url) {
    try {
      detailText = await fetchDetail(ctx.item.url);
    } catch {
      detailText = null;
    }
  }
  if (!detailText) detailText = ctx.item.context;

  const rawText = buildEligibilityPreamble(ctx.source, ctx.cls, detailText);
  const stub = buildScrapedGrantInsert(ctx);

  // Dedup: an already-promoted item re-queues its existing grants row; a new one inserts. Mirrors the
  // ingest route's source_url reuse, so a re-detected opportunity never spawns a duplicate grant.
  const existingGrantId = await findGrantIdForItem(db, ctx.itemId);
  let grantId: string;
  let action: "inserted" | "requeued";
  if (existingGrantId) {
    await db
      .from("grants")
      .update({ status: "processing", processing_started_at: now(), grant_status: stub.grant_status })
      .eq("id", existingGrantId);
    grantId = existingGrantId;
    action = "requeued";
  } else {
    const insertRow: Record<string, unknown> = { source_url: stub.source_url, title: stub.title, ar_source_item_id: stub.ar_source_item_id, status: "processing" };
    if (stub.grant_status) insertRow.grant_status = stub.grant_status;
    const { data, error } = await db.from("grants").insert(insertRow).select("id").single();
    if (error || !data) return { grantId: null, action: "failed" };
    grantId = data.id as string;
    action = "inserted";
  }

  // Hand to the existing pipeline. url=undefined so runPipeline uses our seeded rawText and never
  // re-fetches (which would drop the preamble). Errors park the row at status='error' (self-healing
  // via the watchdog), exactly like the ingest route.
  schedule(
    pipeline(grantId, undefined, rawText, db).catch(async (err: unknown) => {
      await db
        .from("grants")
        .update({ status: "error", error_detail: String((err as { message?: string })?.message ?? err).slice(0, 600) })
        .eq("id", grantId);
    }),
  );

  return { grantId, action };
}
