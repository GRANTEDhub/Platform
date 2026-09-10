import type { SupabaseClient } from "@supabase/supabase-js";
import { needsHeadless } from "@/lib/ar-state/fixture";
import { listMonitorRows, updateMonitorHash } from "@/lib/ar-state/store";
import { buildSeedPreamble, contentHashOf, defaultFetchText, defaultRunPipeline, type SeedDeps } from "@/lib/ar-state/add-source";

// The weekly monitor — piece 2. It mirrors the SGG loop for state programs: re-fetch each monitored
// page (headless where the domain needs it), diff its content hash, and on a REAL change re-derive the
// grant (re-shred + re-match) through the existing pipeline. The "cross-reference against clients"
// step is free: re-matching is what runPipeline does, and the standing client-match cron already
// re-scores every grant against active clients regardless of source.
//
// FLAG-GATED OFF by default (AR_STATE_MONITOR_ENABLED). Off = the cron reads and writes nothing (the
// route short-circuits before this runs) — the instant kill-switch, flipped only after a clean seed +
// a look at the repository.

export function arStateMonitorEnabled(): boolean {
  return process.env.AR_STATE_MONITOR_ENABLED === "true";
}

const DEFAULT_BUDGET_MS = 240_000;

export interface MonitorOptions extends SeedDeps {
  limit?: number;
  budgetMs?: number;
}

export interface MonitorReport {
  checked: number;
  changed: number; // pages whose content actually moved since last check
  rederived: number; // grants re-shred + re-matched (changed, plus first-time enrichment of a thin seed)
  unreachable: number;
  skipped: number; // monitor_mode='reference' (no page to diff)
  results: Array<Record<string, unknown>>;
}

export async function runMonitor(db: SupabaseClient, opts: MonitorOptions = {}): Promise<MonitorReport> {
  const rows = await listMonitorRows(db, { jurisdiction: "AR" });
  const fetchText = opts.fetchText ?? defaultFetchText;
  const pipeline = opts.runPipelineImpl ?? defaultRunPipeline;
  const budgetMs = opts.budgetMs ?? DEFAULT_BUDGET_MS;
  const startedAt = Date.now();
  const rep: MonitorReport = { checked: 0, changed: 0, rederived: 0, unreachable: 0, skipped: 0, results: [] };

  for (const row of rows) {
    if (Date.now() - startedAt >= budgetMs) break;
    if (opts.limit != null && rep.checked >= opts.limit) break;

    // A 'reference' program has no scrapable page to diff (the later philanthropy case) — never today,
    // but honored so the same table serves that build without a monitor change.
    if (row.monitor_mode === "reference") {
      rep.skipped++;
      continue;
    }
    rep.checked++;

    const headless = needsHeadless(row.monitor_url);
    const fetched = await fetchText(row.monitor_url, headless);
    if (!fetched.ok) {
      // Only the check timestamp moves — a transient outage must not read as "the page went blank".
      rep.unreachable++;
      await updateMonitorHash(db, row.id, {});
      rep.results.push({ url: row.monitor_url, action: "unreachable", reason: fetched.reason });
      continue;
    }

    const hash = contentHashOf(fetched.text);
    const baseline = row.last_content_hash;
    const firstBaseline = baseline == null; // seed couldn't read the page -> enrich now that it can
    const changed = baseline != null && baseline !== hash;
    const shouldDerive = firstBaseline || changed;

    if (!shouldDerive) {
      await updateMonitorHash(db, row.id, { hash });
      rep.results.push({ url: row.monitor_url, action: "unchanged" });
      continue;
    }

    // Re-derive THIS grant. url=undefined so runPipeline shreds our rendered text + preamble (never a
    // plain re-fetch, which would drop headless + the identity). Identity comes from the grant row, so
    // a shared page still resolves to this specific program. Commit the new baseline ONLY after the
    // re-derive succeeds — a thrown/killed pipeline must leave the OLD hash so next week detects the
    // change again and retries, rather than reading "unchanged" and abandoning a stale grant (Codex P1).
    const rawText = buildSeedPreamble({ grantor: row.grantor, program: row.program, url: row.monitor_url }, fetched.text);
    try {
      await pipeline(row.grant_id, undefined, rawText, db);
      await updateMonitorHash(db, row.id, { hash, changed });
      if (changed) rep.changed++;
      rep.rederived++;
      rep.results.push({ url: row.monitor_url, action: changed ? "re-derived" : "baseline-enriched" });
    } catch (err) {
      // Advance only the check timestamp — keep the old baseline so the change is re-detected next run.
      await updateMonitorHash(db, row.id, {});
      await db
        .from("grants")
        .update({ status: "error", error_detail: String(err instanceof Error ? err.message : err).slice(0, 600) })
        .eq("id", row.grant_id);
      rep.results.push({ url: row.monitor_url, action: "re-derive-error", reason: String(err instanceof Error ? err.message : err).slice(0, 120) });
    }
  }

  return rep;
}
