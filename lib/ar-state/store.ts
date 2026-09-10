import type { SupabaseClient } from "@supabase/supabase-js";
import type { FunderType, Jurisdiction, MonitorMode } from "@/lib/ar-state/fixture";

// Service-role DB ops for the AR state repository. grant_monitor_state (migration 0095) is
// staff-SELECT-only with NO write policy, so every write here runs under the service role (the cron /
// admin route) — the 0094/0080 pattern. Provenance is "has a grant_monitor_state row": the SGG cron
// and every other writer never touch these rows, and this writer only ever touches grants it created.

function logWrite(op: string, error: unknown): void {
  if (error) console.error(`ar-state store: ${op} write failed:`, error instanceof Error ? error.message : error);
}

// Dedup against the whole grants corpus BEFORE inserting — the same source_url reuse the on-demand
// ingest route uses (and the grants_source_url_uniq partial index backstops). A seed entry whose URL
// already produced a grant (a prior manual paste, or an earlier seed run) is SKIPPED, never
// duplicated, which is what makes the seed idempotent and a re-run a no-op.
export async function findExistingGrantByUrl(
  db: SupabaseClient,
  url: string,
): Promise<{ id: string; status: string | null } | null> {
  const { data } = await db
    .from("grants")
    .select("id, status")
    .eq("source_url", url)
    .order("ingested_at", { ascending: false })
    .limit(1);
  return data && data.length > 0 ? { id: data[0].id as string, status: (data[0].status as string | null) ?? null } : null;
}

export interface InsertMonitorArgs {
  grantId: string;
  jurisdiction: Jurisdiction;
  funderType: FunderType;
  monitorMode: MonitorMode;
  monitorUrl: string;
  seedBatch: string;
}

// Insert the monitor row with a NULL baseline hash — the baseline is committed only AFTER a successful
// initial shred (commitMonitorBaseline), so a seed whose shred fails leaves a null hash and the weekly
// monitor re-derives it (first-baseline) rather than treating it as permanently up-to-date. Returns
// false on a write error so the caller can ROLL BACK the grant shell: a grant that is "seeded" but has
// no monitor row would be invisible to the monitor forever AND dedup-skipped on every retry (Codex P1).
export async function insertMonitorState(db: SupabaseClient, a: InsertMonitorArgs): Promise<boolean> {
  const { error } = await db.from("grant_monitor_state").insert({
    grant_id: a.grantId,
    jurisdiction: a.jurisdiction,
    funder_type: a.funderType,
    monitor_mode: a.monitorMode,
    monitor_url: a.monitorUrl,
    seed_batch: a.seedBatch,
    last_content_hash: null,
    last_checked_at: new Date().toISOString(),
  });
  if (error) logWrite(`insertMonitorState(${a.monitorUrl})`, error);
  return !error;
}

// Commit the change-detection baseline AFTER a successful derive, keyed by grant_id (unique per grant).
export async function commitMonitorBaseline(db: SupabaseClient, grantId: string, hash: string): Promise<void> {
  const now = new Date().toISOString();
  const { error } = await db
    .from("grant_monitor_state")
    .update({ last_content_hash: hash, last_checked_at: now })
    .eq("grant_id", grantId);
  logWrite("commitMonitorBaseline", error);
}

// A monitored row joined to the fields the weekly re-derive needs from its grant (funder + title carry
// the program identity, so a shared-page re-shred can still tell siblings apart without storing
// seed_text). grant_id may point at a since-removed grant (LEFT-ish join); a null grant is skipped.
export interface MonitorRow {
  id: string;
  grant_id: string;
  monitor_url: string;
  monitor_mode: MonitorMode;
  last_content_hash: string | null;
  grantor: string | null;
  program: string | null;
}

export async function listMonitorRows(
  db: SupabaseClient,
  opts: { jurisdiction?: Jurisdiction } = {},
): Promise<MonitorRow[]> {
  let q = db
    .from("grant_monitor_state")
    .select("id, grant_id, monitor_url, monitor_mode, last_content_hash, grants(funder, title)");
  if (opts.jurisdiction) q = q.eq("jurisdiction", opts.jurisdiction);
  const { data, error } = await q;
  if (error) {
    logWrite("listMonitorRows", error);
    return [];
  }
  return (data ?? []).map((r) => {
    const g = (r as { grants?: { funder?: string | null; title?: string | null } | null }).grants;
    return {
      id: r.id as string,
      grant_id: r.grant_id as string,
      monitor_url: r.monitor_url as string,
      monitor_mode: (r.monitor_mode as MonitorMode) ?? "auto",
      last_content_hash: (r.last_content_hash as string | null) ?? null,
      grantor: g?.funder ?? null,
      program: g?.title ?? null,
    };
  });
}

// Advance the change-detection state after a check. `changed` stamps last_changed_at; a re-derive
// caller passes the new hash. A check that couldn't read the page passes hash undefined -> only
// last_checked_at moves, so a transient outage never looks like "the page went blank" next run.
export async function updateMonitorHash(
  db: SupabaseClient,
  id: string,
  opts: { hash?: string; changed?: boolean },
): Promise<void> {
  const now = new Date().toISOString();
  const patch: Record<string, unknown> = { last_checked_at: now };
  if (opts.hash !== undefined) patch.last_content_hash = opts.hash;
  if (opts.changed) patch.last_changed_at = now;
  const { error } = await db.from("grant_monitor_state").update(patch).eq("id", id);
  logWrite("updateMonitorHash", error);
}
