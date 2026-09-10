import type { SupabaseClient } from "@supabase/supabase-js";
import { AR_GRANT_SOURCES, type ArGrantSource } from "@/lib/ar-grants/sources";
import type { ItemStatus } from "@/lib/ar-grants/sources";

// Service-role DB ops for the AR scraper. Both 0094 tables are staff-SELECT-only with NO write
// policy, so every write here runs under the service role (the cron / admin route) — the 0080/0086
// pattern. Nothing in this module is reachable by a client member.

// ── SOURCE REGISTRY SYNC ──
//
// Source DEFINITIONS live in code (sources.ts); this syncs them into ar_grant_sources while PRESERVING
// each row's runtime state (last_hash / last_checked / last_changed). A manual select-then-write sync
// rather than an upsert, because 0094 puts no unique constraint on `url` (nothing to conflict on) and
// the writer is a single serial cron — no concurrency to race. Orphan rows (a url no longer in the
// seed) are deactivated, not deleted, so their history survives.
export async function ensureSources(db: SupabaseClient): Promise<ArGrantSource[]> {
  const { data: existingRows } = await db.from("ar_grant_sources").select("*");
  const existing = existingRows ?? [];
  const byUrl = new Map(existing.map((r) => [r.url as string, r]));
  const seedUrls = new Set(AR_GRANT_SOURCES.map((s) => s.url));

  for (const seed of AR_GRANT_SOURCES) {
    const def = {
      agency: seed.agency,
      cluster: seed.cluster,
      geo_tag: seed.geo_tag,
      elig_tag: seed.elig_tag,
      funding_type: seed.funding_type,
      fetch_mode: seed.fetch_mode,
      rss_url: seed.rss_url ?? null,
      active: true,
      updated_at: new Date().toISOString(),
    };
    const match = byUrl.get(seed.url);
    if (match) {
      await db.from("ar_grant_sources").update(def).eq("id", match.id);
    } else {
      await db.from("ar_grant_sources").insert({ url: seed.url, ...def });
    }
  }
  // Deactivate any stored source no longer in the code seed.
  for (const row of existing) {
    if (!seedUrls.has(row.url as string) && row.active) {
      await db.from("ar_grant_sources").update({ active: false, updated_at: new Date().toISOString() }).eq("id", row.id);
    }
  }

  const { data: fresh } = await db.from("ar_grant_sources").select("*").eq("active", true).order("agency");
  return (fresh ?? []) as ArGrantSource[];
}

export async function updateSourceState(
  db: SupabaseClient,
  sourceId: string,
  opts: { lastHash: string; changed: boolean },
): Promise<void> {
  const now = new Date().toISOString();
  const patch: Record<string, unknown> = { last_hash: opts.lastHash, last_checked: now, updated_at: now };
  if (opts.changed) patch.last_changed = now;
  await db.from("ar_grant_sources").update(patch).eq("id", sourceId);
}

// ── ITEMS ──

export interface StoredItem {
  id: string;
  external_ref: string;
  item_hash: string | null;
  status: ItemStatus;
}

export async function listItemsBySource(db: SupabaseClient, sourceId: string): Promise<StoredItem[]> {
  const { data } = await db
    .from("ar_source_items")
    .select("id, external_ref, item_hash, status")
    .eq("source_id", sourceId);
  return (data ?? []) as StoredItem[];
}

export interface NewItemRow {
  source_id: string;
  external_ref: string;
  doc_type: string;
  title: string;
  detail_url: string | null;
  funding_type: string;
  geo_tag: string;
  elig_tag: string;
  item_hash: string;
  status: ItemStatus;
}

export async function insertItem(db: SupabaseClient, row: NewItemRow): Promise<string | null> {
  const { data, error } = await db.from("ar_source_items").insert(row).select("id").single();
  if (error || !data) return null;
  return data.id as string;
}

export async function touchItem(db: SupabaseClient, id: string): Promise<void> {
  await db.from("ar_source_items").update({ last_seen_at: new Date().toISOString() }).eq("id", id);
}

export async function markItemChanged(db: SupabaseClient, id: string, itemHash: string): Promise<void> {
  const now = new Date().toISOString();
  await db.from("ar_source_items").update({ item_hash: itemHash, changed_at: now, last_seen_at: now, status: "changed" }).eq("id", id);
}

export async function setItemStatus(db: SupabaseClient, id: string, status: ItemStatus): Promise<void> {
  await db.from("ar_source_items").update({ status, last_seen_at: new Date().toISOString() }).eq("id", id);
}

// The grants row a promoted item produced (grants.ar_source_item_id back-reference). Null when the
// item was never promoted (loan/pdf) or its grant row was since removed.
export async function findGrantIdForItem(db: SupabaseClient, itemId: string): Promise<string | null> {
  const { data } = await db
    .from("grants")
    .select("id")
    .eq("ar_source_item_id", itemId)
    .order("ingested_at", { ascending: false })
    .limit(1);
  return data && data.length > 0 ? (data[0].id as string) : null;
}
