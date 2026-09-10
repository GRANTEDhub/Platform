import type { SupabaseClient } from "@supabase/supabase-js";
import { AR_STATE_SEED } from "@/lib/ar-state/fixture";
import { addSource, planSource, seedSourceUrl, type SeedDeps } from "@/lib/ar-state/add-source";
import { findExistingGrantByUrl } from "@/lib/ar-state/store";

// The one-time seed orchestrator, shared by the admin route's GET (dry-run) and POST (apply).
//
// APPLY is TIME-BUDGETED + IDEMPOTENT: each seeded grant runs a full shred+match inline (promote.ts's
// pattern), so one 300s request can't take all 40. The loop stops claiming new work past the budget
// (or an optional per-run limit) and reports `remaining` — POST again to continue. A re-run skips
// anything already in the corpus (the source_url dedup), so repeated POSTs simply make progress and a
// finished seed reports 0 remaining. DRY-RUN writes nothing: it reports what WOULD seed / skip and, for
// a verify_url entry (or ?probe=all), whether the URL is reachable.

const DEFAULT_BUDGET_MS = 240_000;

export interface SeedOptions extends SeedDeps {
  apply: boolean;
  limit?: number; // apply: cap entries actually seeded this invocation
  budgetMs?: number; // apply: wall-clock budget before deferring the rest to the next POST
  probeReach?: boolean; // dry-run: fetch every URL for reachability (default: only verify_url entries)
}

export interface SeedReport {
  apply: boolean;
  total: number;
  would_seed: number; // dry-run: entries that would be newly seeded
  seeded: number; // apply: entries actually seeded this run
  skipped: number; // already in the corpus (dedup) — never duplicated
  errored: number;
  remaining: number; // apply: entries not reached this run (budget/limit) — POST again to continue
  flagged: string[]; // notes worth eyeballing (verify_url reachability, errors)
  results: Array<Record<string, unknown>>;
}

export async function runSeed(db: SupabaseClient, opts: SeedOptions): Promise<SeedReport> {
  const budgetMs = opts.budgetMs ?? DEFAULT_BUDGET_MS;
  const startedAt = Date.now();
  const r: SeedReport = {
    apply: opts.apply,
    total: AR_STATE_SEED.length,
    would_seed: 0,
    seeded: 0,
    skipped: 0,
    errored: 0,
    remaining: 0,
    flagged: [],
    results: [],
  };

  for (const entry of AR_STATE_SEED) {
    if (!opts.apply) {
      const plan = await planSource(db, entry, opts, opts.probeReach);
      if (plan.action === "skip_exists") r.skipped++;
      else {
        r.would_seed++;
        if (plan.note) r.flagged.push(`${entry.program}: ${plan.note}`);
      }
      r.results.push(plan);
      continue;
    }

    // APPLY. Past the budget/limit, stop seeding — but still resolve dedup so an already-seeded entry
    // isn't miscounted as remaining work.
    const overBudget = Date.now() - startedAt >= budgetMs;
    const overLimit = opts.limit != null && r.seeded >= opts.limit;
    if (overBudget || overLimit) {
      const existing = await findExistingGrantByUrl(db, seedSourceUrl(entry));
      if (existing) r.skipped++;
      else r.remaining++;
      continue;
    }

    const res = await addSource(db, entry, opts);
    if (res.action === "seeded") r.seeded++;
    else if (res.action === "skip_exists") r.skipped++;
    else {
      r.errored++;
      r.flagged.push(`${entry.program}: ${res.reason}`);
    }
    r.results.push(res);
  }

  return r;
}
