// Program-level award history (#107 Part 2).
//
// Given a grant's assistance-listing / CFDA number(s), pull PROGRAM-WIDE award
// history from USASpending -- every award under those CFDAs across a rolling
// 10-year window, NOT this specific NOFO's awards. Distinct from the recipient-
// name lookup in lib/grants/usaspending.ts (that one scores a single client's
// past performance; this one profiles a whole federal program).
//
// Two endpoints, both filtered by program_numbers (CFDA -- the exact key, no
// agency-name fuzziness) and recipient_location scope (recipient HQ state):
//   - spending_by_geography -> per-state AMOUNT (authoritative, program-wide) ->
//     the choropleth fill. It returns NO count.
//   - spending_by_award     -> the top-N award table AND, aggregated client-side
//     by recipient state, the per-state COUNT.
//
// Refresh is a FULL re-pull on a rolling window (award history is append-only, but
// at this volume a full pull is trivially cheap and avoids incremental merge/dedup
// + late-post + window-eviction complexity). Never called on the hot path -- the
// map reads the cached program_award_summary; the cron sweep + admin backfill
// populate it.

import { createServiceClient } from "@/lib/supabase/server";

type DB = ReturnType<typeof createServiceClient>;

const USASPENDING = "https://api.usaspending.gov/api/v2";
// Grants + cooperative agreements (block / formula / project / coop). Excludes
// loans, direct payments, insurance.
const AWARD_TYPE_CODES = ["02", "03", "04", "05"];
const WINDOW_YEARS = 10;
const AWARD_PAGE_SIZE = 100;
const MAX_AWARD_PAGES = 5; // cap the award fetch at 500 for counting
const TOP_AWARDS = 50; // how many awards we store for the click-through table

export interface ProgramAwardState {
  state: string; // 2-letter code
  name: string;
  amount: number; // from spending_by_geography (program-wide, authoritative)
  count: number; // from the award fetch (see awardsTruncated caveat)
}
export interface ProgramAwardRow {
  awardId: string;
  recipient: string;
  amount: number;
  agency: string;
  startDate: string;
  state: string | null; // recipient HQ state code
}
export interface ProgramAwardSummary {
  cfdas: string[];
  programTitles: string[];
  scope: "recipient_location";
  timePeriod: { start: string; end: string };
  totalAmount: number;
  totalAwardsFetched: number;
  // true when the program has more awards than our fetch cap -> per-state counts
  // are a floor, not exact (Part 3 renders "N+").
  awardsTruncated: boolean;
  byState: ProgramAwardState[];
  topAwards: ProgramAwardRow[];
}

type Listing = { number: string; program_title: string };

// Defensively normalize the jsonb assistance_listings column into {number, title}.
export function normalizeListings(raw: unknown): Listing[] {
  if (!Array.isArray(raw)) return [];
  const out: Listing[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") continue;
    const e = entry as Record<string, unknown>;
    const number = typeof e.number === "string" ? e.number.trim() : "";
    if (!number) continue;
    out.push({ number, program_title: typeof e.program_title === "string" ? e.program_title : "" });
  }
  return out;
}

// Rolling window: now-10y .. now. Recomputed each fetch so a full re-pull always
// drops awards aging past 10 years and includes the latest -- no window eviction
// logic needed.
function windowDates(): { start: string; end: string } {
  const end = new Date();
  const start = new Date(end);
  start.setFullYear(start.getFullYear() - WINDOW_YEARS);
  return { start: start.toISOString().slice(0, 10), end: end.toISOString().slice(0, 10) };
}

async function postUSA(path: string, body: unknown): Promise<Record<string, unknown>> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30000);
  try {
    const res = await fetch(`${USASPENDING}${path}`, {
      method: "POST",
      signal: controller.signal,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`USASpending ${path} -> HTTP ${res.status}`);
    return (await res.json()) as Record<string, unknown>;
  } finally {
    clearTimeout(timeout);
  }
}

// Core query. Empty/no CFDAs -> null (manual-paste / non-Simpler grants; Part 3
// shows "no program data"). Never throws for a no-data program -- only a genuine
// API/network failure propagates so the caller can avoid stamping checked_at.
export async function fetchProgramAwardHistory(
  cfdas: string[],
  programTitles: string[] = [],
): Promise<ProgramAwardSummary | null> {
  const numbers = Array.from(new Set(cfdas.map((c) => c.trim()).filter(Boolean)));
  if (numbers.length === 0) return null;

  const { start, end } = windowDates();
  const filters = {
    program_numbers: numbers,
    award_type_codes: AWARD_TYPE_CODES,
    time_period: [{ start_date: start, end_date: end }],
  };

  // 1) Per-state AMOUNT (program-wide, authoritative). No count field exists here.
  const geo = await postUSA("/search/spending_by_geography/", {
    scope: "recipient_location",
    geo_layer: "state",
    spending_level: "awards",
    filters,
  });
  const amountByState = new Map<string, { name: string; amount: number }>();
  for (const row of (geo.results ?? []) as Record<string, unknown>[]) {
    const code = typeof row.shape_code === "string" ? row.shape_code : "";
    if (!code) continue;
    amountByState.set(code, {
      name: typeof row.display_name === "string" ? row.display_name : code,
      amount: Number(row.aggregated_amount) || 0,
    });
  }

  // 2) Awards -> top-N table + per-state COUNT. Paginate to the cap.
  const awards: ProgramAwardRow[] = [];
  const countByState = new Map<string, number>();
  let awardsTruncated = false;
  for (let page = 1; page <= MAX_AWARD_PAGES; page++) {
    const res = await postUSA("/search/spending_by_award/", {
      filters,
      fields: ["Award ID", "Recipient Name", "Award Amount", "Awarding Agency", "Start Date", "Recipient Location"],
      page,
      limit: AWARD_PAGE_SIZE,
      sort: "Award Amount",
      order: "desc",
    });
    const rows = (res.results ?? []) as Record<string, unknown>[];
    for (const row of rows) {
      const loc = (row["Recipient Location"] ?? {}) as Record<string, unknown>;
      const state = typeof loc.state_code === "string" ? loc.state_code : null;
      awards.push({
        awardId: String(row["Award ID"] ?? row["internal_id"] ?? ""),
        recipient: typeof row["Recipient Name"] === "string" ? row["Recipient Name"] : "",
        amount: Number(row["Award Amount"]) || 0,
        agency: typeof row["Awarding Agency"] === "string" ? row["Awarding Agency"] : "",
        startDate: typeof row["Start Date"] === "string" ? row["Start Date"] : "",
        state,
      });
      if (state) countByState.set(state, (countByState.get(state) ?? 0) + 1);
    }
    const meta = (res.page_metadata ?? {}) as Record<string, unknown>;
    const hasNext = meta.hasNext === true;
    if (!hasNext) break;
    if (page === MAX_AWARD_PAGES) awardsTruncated = true;
  }

  // 3) Merge: amount from geography, count from the award fetch. Union of states
  // seen in either (a state can have amount from geography but 0 counted awards
  // only when awardsTruncated).
  const stateCodes = new Set<string>([...amountByState.keys(), ...countByState.keys()]);
  const byState: ProgramAwardState[] = [...stateCodes]
    .map((code) => ({
      state: code,
      name: amountByState.get(code)?.name ?? code,
      amount: amountByState.get(code)?.amount ?? 0,
      count: countByState.get(code) ?? 0,
    }))
    .sort((a, b) => b.amount - a.amount);

  return {
    cfdas: numbers,
    programTitles: programTitles.filter(Boolean),
    scope: "recipient_location",
    timePeriod: { start, end },
    totalAmount: byState.reduce((s, x) => s + x.amount, 0),
    totalAwardsFetched: awards.length,
    awardsTruncated,
    byState,
    topAwards: awards.slice(0, TOP_AWARDS), // API already sorts by amount desc
  };
}

// Refresh one grant: read its CFDAs -> full re-pull -> persist. Stamps
// program_award_checked_at on every path (incl. no-CFDA, where summary stays null)
// so a no-CFDA grant isn't re-selected every sweep. A thrown API error does NOT
// stamp (the update never runs) -> the grant retries next sweep.
export async function refreshProgramAwards(
  grantId: string,
  db: DB,
): Promise<{ ok: boolean; cfdas: number; states: number }> {
  const { data: grant } = await db
    .from("grants")
    .select("id, assistance_listings")
    .eq("id", grantId)
    .single<{ id: string; assistance_listings: unknown }>();
  const listings = normalizeListings(grant?.assistance_listings);
  const cfdas = listings.map((l) => l.number);
  const nowIso = new Date().toISOString();

  if (cfdas.length === 0) {
    await db.from("grants").update({ program_award_summary: null, program_award_checked_at: nowIso }).eq("id", grantId);
    return { ok: false, cfdas: 0, states: 0 };
  }

  const summary = await fetchProgramAwardHistory(cfdas, listings.map((l) => l.program_title));
  await db.from("grants").update({ program_award_summary: summary, program_award_checked_at: nowIso }).eq("id", grantId);
  return { ok: true, cfdas: cfdas.length, states: summary?.byState.length ?? 0 };
}

// Client-matched grant ids: any review_card that is NOT a prospect card (mirrors
// gate.ts isClientCard -- null or <> 'prospect' counts as a client card). The
// bounded target set for both the cron sweep and the admin backfill.
export async function clientMatchedGrantIds(db: DB): Promise<string[]> {
  const { data } = await db
    .from("review_cards")
    .select("grant_id, card_type")
    .not("grant_id", "is", null)
    .or("card_type.is.null,card_type.neq.prospect");
  const ids = Array.from(
    new Set(((data ?? []) as { grant_id: string | null }[]).map((r) => r.grant_id).filter(Boolean)),
  ) as string[];
  ids.sort();
  return ids;
}

// Bounded cron sweep: refresh stale, client-matched, CFDA-carrying grants. Full
// re-pull each (append-only history, but a full pull is trivially cheap here).
export async function sweepProgramAwards(
  db: DB,
  opts: { cap: number; staleDays: number },
): Promise<{ refreshed: number; failed: number; processed: number; more: boolean }> {
  const ids = await clientMatchedGrantIds(db);
  if (ids.length === 0) return { refreshed: 0, failed: 0, processed: 0, more: false };
  const cutoff = new Date(Date.now() - opts.staleDays * 86_400_000).toISOString();

  const { data: grants } = await db
    .from("grants")
    .select("id, assistance_listings, program_award_checked_at")
    .in("id", ids)
    .not("assistance_listings", "is", null)
    .or(`program_award_checked_at.is.null,program_award_checked_at.lt.${cutoff}`)
    .limit(opts.cap);

  const targets = ((grants ?? []) as { id: string; assistance_listings: unknown }[]).filter(
    (g) => normalizeListings(g.assistance_listings).length > 0,
  );

  let refreshed = 0;
  let failed = 0;
  for (const g of targets) {
    try {
      const r = await refreshProgramAwards(g.id, db);
      if (r.ok) refreshed++;
      else failed++;
    } catch (err) {
      console.error("program-award refresh failed for grant", g.id, err);
      failed++;
    }
  }
  return { refreshed, failed, processed: targets.length, more: targets.length === opts.cap };
}
