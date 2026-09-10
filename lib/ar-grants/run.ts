import type { SupabaseClient } from "@supabase/supabase-js";
import {
  agencySlug,
  classifyItem,
  externalRef,
  itemHash,
} from "@/lib/ar-grants/classify";
import { fetchSource as defaultFetchSource, type FetchTextFn, type SourceFetchResult } from "@/lib/ar-grants/fetch";
import {
  ensureSources,
  findGrantIdForItem,
  insertItem,
  listItemsBySource,
  markItemChanged,
  setItemStatus,
  touchItem,
  updateSourceState,
} from "@/lib/ar-grants/store";
import { AR_GRANT_SOURCES, type ArGrantSource } from "@/lib/ar-grants/sources";
import type { PromoteContext } from "@/lib/ar-grants/promote";

// The orchestrator, shared by the weekly cron and the manual admin route. It is the ONLY place the
// scan's control flow lives; the routes are thin wrappers.
//
// DEPENDENCY INJECTION KEEPS THE PROTECTED PIPELINE OUT OF THIS MODULE. `promote` is passed in — the
// route supplies the real promoteOpportunity (which imports the exported runPipeline); tests pass a
// fake. So run.ts imports only light, pure modules and is unit-testable with a fake DB + fake promote,
// and the single reach into the pipeline stays in the route.
//
// APPLY vs DRY-RUN. apply=true writes (ensures sources, upserts items, promotes, records the hash).
// apply=false is READ-ONLY: it fetches + classifies + reports exactly what WOULD happen, writing
// nothing — the admin GET preview / "look before you flip".

export type PromoteFn = (
  db: SupabaseClient,
  ctx: PromoteContext,
) => Promise<{ grantId: string | null; action: "inserted" | "requeued" | "failed" }>;

export interface ScanOptions {
  apply: boolean;
  promoteMax?: number; // GLOBAL cap on runPipeline hand-offs per run (bounds cron time); default 20
  promoteMaxPerSource?: number; // per-source cap so one dense source can't eat the global cap; default 8
  fetchText?: FetchTextFn;
  fetchSourceImpl?: (source: ArGrantSource, fetchText?: FetchTextFn) => Promise<SourceFetchResult>;
  promote: PromoteFn;
}

export interface SourceResult {
  agency: string;
  url: string;
  fetch_ok: boolean;
  reason?: string;
  fetched: number; // raw hits extracted
  opportunities: number; // classified grant-type opportunities
  loans: number; // classified loans (never promoted)
  pdfs: number; // classified PDF links (flagged only)
  new_items: number;
  changed: number;
  promoted: number; // hand-offs to the pipeline (insert or re-queue)
  deferred: number; // opportunities not promoted this run because the cap was hit
  content_changed: boolean; // the source page hash moved since last run
  note?: string; // e.g. an empty fetch that likely needs a URL fix / is JS-rendered
}

export interface ScanReport {
  apply: boolean;
  ran_at: string;
  promote_cap: number;
  sources: SourceResult[];
  totals: { opportunities: number; loans: number; pdfs: number; new_items: number; changed: number; promoted: number; deferred: number; errors: number };
}

const DEFAULT_PROMOTE_MAX = 20;
const DEFAULT_PROMOTE_MAX_PER_SOURCE = 8;

// The AUTOMATIC weekly cron is gated OFF by default: it runs NOTHING until AR_GRANTS_CRON_ENABLED is
// set to "true" (a Vercel env change + redeploy, not a live toggle). This is the "cron stays off
// until a clean dry-run is approved" switch — flipping it is the deliberate go-live step. The admin
// route (dry-run + manual apply) is intentionally NOT gated by this, so staff can verify sources and
// hand-run regardless. Off = the cron reads and writes nothing.
export function arGrantsCronEnabled(): boolean {
  return process.env.AR_GRANTS_CRON_ENABLED === "true";
}

export async function runArGrantsScan(db: SupabaseClient, opts: ScanOptions): Promise<ScanReport> {
  const promoteMax = opts.promoteMax ?? DEFAULT_PROMOTE_MAX;
  const perSourceMax = opts.promoteMaxPerSource ?? DEFAULT_PROMOTE_MAX_PER_SOURCE;
  const fetchSourceImpl = opts.fetchSourceImpl ?? defaultFetchSource;
  const ranAt = new Date().toISOString();

  const sources = opts.apply ? await ensureSources(db) : await readActiveSources(db);
  const results: SourceResult[] = [];
  let promotedTotal = 0;

  for (const source of sources) {
    const r: SourceResult = {
      agency: source.agency,
      url: source.url,
      fetch_ok: false,
      fetched: 0,
      opportunities: 0,
      loans: 0,
      pdfs: 0,
      new_items: 0,
      changed: 0,
      promoted: 0,
      deferred: 0,
      content_changed: false,
    };
    let promotedThisSource = 0;

    let fetched: SourceFetchResult;
    try {
      fetched = await fetchSourceImpl(source, opts.fetchText);
    } catch (err) {
      r.reason = err instanceof Error ? err.message : "fetch threw";
      results.push(r);
      continue;
    }
    if (!fetched.ok) {
      r.reason = fetched.reason;
      results.push(r);
      continue;
    }
    r.fetch_ok = true;
    r.fetched = fetched.items.length;
    r.content_changed = source.last_hash !== fetched.contentHash;

    // Existing items for dedup + change detection (read-only, used in both modes).
    const existing = source.id ? await listItemsBySource(db, source.id) : [];
    const byRef = new Map(existing.map((e) => [e.external_ref, e]));

    for (const raw of fetched.items) {
      const cls = classifyItem(raw, source);
      if (!cls) continue; // noise
      if (cls.docType === "opportunity") r.opportunities++;
      else if (cls.docType === "loan") r.loans++;
      else r.pdfs++;

      const ref = externalRef(raw, source);
      const ih = itemHash(raw, cls.forecasted);
      const prior = byRef.get(ref);
      const changed = !!prior && prior.item_hash !== ih;
      if (!prior) r.new_items++;
      else if (changed) r.changed++;

      // An opportunity needs a pipeline hand-off when it is new, its deadline / forecast state changed
      // (decisions 5 + 6), OR it was detected before but never successfully promoted — deferred past
      // the cap, or a transient promote failure. That last clause is what RETRIES overflow + failures
      // on a later run instead of leaving them stuck as 'new'/'changed' forever.
      const needsPromote = cls.docType === "opportunity" && (!prior || changed || prior.status !== "promoted");

      if (!opts.apply) {
        if (needsPromote) {
          if (promotedTotal < promoteMax && promotedThisSource < perSourceMax) {
            r.promoted++;
            promotedTotal++;
            promotedThisSource++;
          } else r.deferred++;
        }
        continue;
      }

      // Persist the item row: insert a new one, mark a changed one, or touch an unchanged one.
      let itemId: string | null;
      if (!prior) {
        itemId = await insertItem(db, {
          source_id: source.id,
          external_ref: ref,
          doc_type: cls.docType,
          title: raw.title.slice(0, 500),
          detail_url: raw.url,
          funding_type: cls.fundingType,
          geo_tag: cls.geoTag,
          elig_tag: cls.eligTag,
          item_hash: ih,
          status: cls.docType === "opportunity" ? "new" : cls.docType === "loan" ? "skipped_loan" : "flagged_pdf",
        });
      } else {
        itemId = prior.id;
        if (changed) await markItemChanged(db, prior.id, ih);
        else await touchItem(db, prior.id);
      }

      // Promote / re-queue within the cap. A transient failure leaves the item un-promoted (status
      // stays new/changed), so needsPromote catches it again next run.
      if (needsPromote && itemId) {
        if (promotedTotal < promoteMax && promotedThisSource < perSourceMax) {
          const res = await opts.promote(db, { source, item: raw, cls, itemId });
          if (res.grantId) {
            await setItemStatus(db, itemId, "promoted");
            r.promoted++;
            promotedTotal++;
            promotedThisSource++;
          }
        } else {
          r.deferred++;
        }
      }
    }

    // An OK fetch that yielded no classified opportunities/loans/pdfs is the signal for a bad URL or a
    // JS-rendered page (open item #2) — surfaced as text, never a colour, for a human to verify.
    if (r.fetch_ok && r.opportunities + r.loans + r.pdfs === 0) {
      r.note = "no opportunities/loans/PDFs detected — verify the source URL or check whether the page is JavaScript-rendered (v1 reads server HTML only)";
    }

    if (opts.apply && source.id) {
      await updateSourceState(db, source.id, { lastHash: fetched.contentHash, changed: r.content_changed });
    }
    results.push(r);
  }

  const totals = results.reduce(
    (acc, s) => ({
      opportunities: acc.opportunities + s.opportunities,
      loans: acc.loans + s.loans,
      pdfs: acc.pdfs + s.pdfs,
      new_items: acc.new_items + s.new_items,
      changed: acc.changed + s.changed,
      promoted: acc.promoted + s.promoted,
      deferred: acc.deferred + s.deferred,
      errors: acc.errors + (s.fetch_ok ? 0 : 1),
    }),
    { opportunities: 0, loans: 0, pdfs: 0, new_items: 0, changed: 0, promoted: 0, deferred: 0, errors: 0 },
  );

  return { apply: opts.apply, ran_at: ranAt, promote_cap: promoteMax, sources: results, totals };
}

// Dry-run source list (no ensureSources write). It ALWAYS previews all 9 code-seed sources, overlaying
// stored runtime state (id + last_hash) where a row already exists — so a fresh deploy's admin GET
// (the recommended "look before you flip" URL check) actually fetches + classifies every source
// instead of returning an empty, all-zero report before the first apply run has seeded the table. An
// unseeded source gets an empty id (no stored items → all hits read as new; no writes in dry-run).
async function readActiveSources(db: SupabaseClient): Promise<ArGrantSource[]> {
  const { data } = await db.from("ar_grant_sources").select("*").eq("active", true);
  const stored = new Map((data ?? []).map((r) => [r.url as string, r as ArGrantSource]));
  return AR_GRANT_SOURCES.map((seed) => {
    const row = stored.get(seed.url);
    // OVERLAY the code-seed DEFINITION (url, tags, funding_type, fetch_mode, rss_url) onto the
    // stored RUNTIME state (id + last_*). Definitions live in code and ensureSources rewrites exactly
    // these on the next apply, so the read-only dry-run must reflect them too — otherwise a source
    // already seeded with an OLD definition (e.g. stored fetch_mode='html' before this change) would
    // shadow the current code and the preview would never exercise the new mode. An unseeded source
    // has no stored row → empty id, null runtime state (byte-identical to the pre-overlay fallback).
    return {
      ...seed,
      id: row?.id ?? "",
      active: true,
      last_hash: row?.last_hash ?? null,
      last_checked: row?.last_checked ?? null,
      last_changed: row?.last_changed ?? null,
    };
  });
}

// Re-exported for the admin surface / tests.
export { agencySlug };
