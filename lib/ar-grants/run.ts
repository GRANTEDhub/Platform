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
import type { ArGrantSource } from "@/lib/ar-grants/sources";
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
  promoteMax?: number; // cap on runPipeline hand-offs per run (bounds cron time); default 20
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

export async function runArGrantsScan(db: SupabaseClient, opts: ScanOptions): Promise<ScanReport> {
  const promoteMax = opts.promoteMax ?? DEFAULT_PROMOTE_MAX;
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
      const ih = itemHash(raw);
      const prior = byRef.get(ref);
      const status = cls.docType === "opportunity" ? "new" : cls.docType === "loan" ? "skipped_loan" : "flagged_pdf";

      if (!prior) {
        r.new_items++;
        if (!opts.apply) {
          // Dry-run: count only. Would-promote iff opportunity within the cap.
          if (cls.docType === "opportunity") {
            if (promotedTotal < promoteMax) {
              r.promoted++;
              promotedTotal++;
            } else r.deferred++;
          }
          continue;
        }
        const id = await insertItem(db, {
          source_id: source.id,
          external_ref: ref,
          doc_type: cls.docType,
          title: raw.title.slice(0, 500),
          detail_url: raw.url,
          funding_type: cls.fundingType,
          geo_tag: cls.geoTag,
          elig_tag: cls.eligTag,
          item_hash: ih,
          status,
        });
        if (id && cls.docType === "opportunity") {
          if (promotedTotal < promoteMax) {
            const res = await opts.promote(db, { source, item: raw, cls, itemId: id });
            if (res.grantId) {
              await setItemStatus(db, id, "promoted");
              r.promoted++;
              promotedTotal++;
            }
          } else {
            r.deferred++; // stays 'new'; promoted on a later run
          }
        }
      } else {
        // Seen before. A moved deadline (item_hash change) re-queues an opportunity (decision 6).
        if (prior.item_hash !== ih) {
          r.changed++;
          if (!opts.apply) {
            if (cls.docType === "opportunity" && promotedTotal < promoteMax) {
              r.promoted++;
              promotedTotal++;
            }
            continue;
          }
          await markItemChanged(db, prior.id, ih);
          if (cls.docType === "opportunity" && promotedTotal < promoteMax) {
            const res = await opts.promote(db, { source, item: raw, cls, itemId: prior.id });
            if (res.grantId) {
              await setItemStatus(db, prior.id, "promoted");
              r.promoted++;
              promotedTotal++;
            }
          }
        } else if (opts.apply) {
          await touchItem(db, prior.id);
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

// Dry-run reads the stored active sources (no ensureSources write). Its dedup uses whatever rows are
// already seeded; an unseeded source simply reports all hits as new, which is the honest preview.
async function readActiveSources(db: SupabaseClient): Promise<ArGrantSource[]> {
  const { data } = await db.from("ar_grant_sources").select("*").eq("active", true).order("agency");
  return (data ?? []) as ArGrantSource[];
}

// Re-exported for the admin surface / tests.
export { agencySlug };
