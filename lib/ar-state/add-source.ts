import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { runPipeline } from "@/lib/grants/pipeline";
import { normalizeForHash, sha256hex, stripToText } from "@/lib/ar-grants/parse";
import { needsHeadless, SEED_BATCH, type SeedGrant } from "@/lib/ar-state/fixture";
import { commitMonitorBaseline, findExistingGrantByUrl, insertMonitorState } from "@/lib/ar-state/store";

// The LLM + headless-browser stacks are pulled in DYNAMICALLY (only when a real fetch/shred runs), so
// this module — and the seed/monitor that import it — stay light for callers that inject their own
// deps (the unit tests), mirroring headless.ts's own lazy launcher import.
export const defaultRunPipeline: typeof runPipeline = (async (grantId, url, rawText, db, opts) =>
  (await import("@/lib/grants/pipeline")).runPipeline(grantId, url, rawText, db, opts)) as typeof runPipeline;

// addSource — the SINGLE write path into the AR state repository. The seed loop, the (future) admin
// console, and (later) Score-a-grant all funnel through here, so there is one definition of "add a
// monitored state program" and they can never drift.
//
// It reuses the EXISTING pipeline with ZERO protected-file edits: it fetches the program page (headless
// where the domain needs it — #531), prepends an authoritative AR preamble, and hands the result to the
// EXPORTED runPipeline exactly the way promote.ts does (url=undefined so runPipeline shreds OUR text and
// never re-fetches — which would drop the headless render + the preamble). runPipeline then shreds AND
// matches against the active roster, so a seeded grant is enriched AND scored with no extra code and no
// re-mapping of its ~30 fields. Cards land decision='pending' in the staff queue — never client-facing
// until an SME release, so matching on seed exposes nothing.

const MAX_PAGE_CHARS = 40_000; // mirror promote.ts's MAX_DETAIL_CHARS — bound the shred input

export type FetchTextResult = { ok: true; text: string } | { ok: false; text: ""; reason: string };

export interface SeedDeps {
  fetchText?: (url: string, headless: boolean) => Promise<FetchTextResult>;
  runPipelineImpl?: typeof runPipeline;
  now?: () => string;
  // A shared absolute deadline (ms epoch) threaded into runPipeline so each item's match is bounded by
  // the same clock as the seed loop — a match truncated at the deadline re-queues and the match drain
  // finishes it, so the request can't be killed mid-work past its cap (Codex P1).
  deadlineMs?: number;
}

// ── page fetch (headless-aware) ───────────────────────────────────────────────────────────────────
// A JS-rendered domain (AEDC/DFA) is rendered in Chromium first and its DOM reduced to text; every
// other page is a plain SSRF-guarded GET. Never throws — a failure is a typed { ok:false } so a bad
// page surfaces as a seed that shredded from the preamble alone, never a crashed seed run.
export const defaultFetchText = async (url: string, headless: boolean): Promise<FetchTextResult> => {
  try {
    if (headless) {
      const { renderHeadless } = await import("@/lib/ar-grants/headless");
      const r = await renderHeadless(url);
      return r.ok ? { ok: true, text: stripToText(r.body).slice(0, MAX_PAGE_CHARS) } : { ok: false, text: "", reason: r.reason };
    }
    const { fetchGrantTextFromUrl } = await import("@/lib/grants/engine");
    const t = await fetchGrantTextFromUrl(url);
    return t ? { ok: true, text: t.slice(0, MAX_PAGE_CHARS) } : { ok: false, text: "", reason: "empty" };
  } catch (err) {
    return { ok: false, text: "", reason: err instanceof Error ? err.message.slice(0, 120) : "fetch_error" };
  }
};

// The change-detection hash — the SAME reduction the AR scraper uses (visible text, lowercased), so a
// cosmetic markup change doesn't read as "the program changed" but a real content change does. Computed
// at seed (the baseline) and again by the weekly monitor; a mismatch is what triggers a re-derive.
export function contentHashOf(text: string): string {
  return sha256hex(normalizeForHash(text));
}

// The authoritative preamble seeded into the shred input. It pins AR geography (so the matcher's geo
// gate reads Arkansas) and the funder/program identity — and for a shared-page program the identity is
// what lets the shred pull THIS program out of a page that lists several. Labelled as GRANTED-supplied
// context, distinct from the source document, exactly like buildEligibilityPreamble.
export function buildSeedPreamble(
  id: { grantor: string | null; program: string | null; seedText?: string; url: string },
  pageText: string,
): string {
  return [
    "[GRANTED AR STATE REGISTRY — AUTHORITATIVE CONTEXT]",
    "This is a State of Arkansas funding program monitored by GRANTED. Apply the following as the opportunity's identity and eligibility unless the source text below explicitly states otherwise:",
    `- FUNDER: ${id.grantor ?? "an Arkansas state agency"}`,
    `- PROGRAM: ${id.program ?? "(see source)"}`,
    "- ELIGIBLE GEOGRAPHY / SERVICE AREA: the State of Arkansas. Applicants must be located in or primarily serve Arkansas.",
    id.seedText ? `- PROGRAM SUMMARY: ${id.seedText}` : "",
    `- SOURCE: ${id.url}`,
    "[END CONTEXT]",
    "",
    pageText ||
      "(The live program page could not be read at seed time — derive the program from the identity and summary above. The weekly monitor will refresh this from the live page.)",
  ]
    .filter(Boolean)
    .join("\n");
}

// The grant's source_url — the identity + dedup key + the grants_source_url_uniq partial index. For a
// SHARED-PAGE program (several distinct grants on one landing page — the Arts Council / Historic
// Preservation / Main Street / DPS-fire clusters) the bare page url would collide, so a per-program
// fragment makes each grant unique while still resolving to the same page in a browser. The MONITOR
// still watches the bare page (monitor_url), so all siblings re-derive together when it changes.
export function seedSourceUrl(entry: SeedGrant): string {
  if (!entry.tags?.includes("shared_page")) return entry.url;
  const slug = entry.program.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48);
  return `${entry.url}#${slug}`;
}

export type AddResult =
  | { action: "seeded"; grantId: string; fetchOk: boolean }
  | { action: "skip_exists"; grantId: string }
  | { action: "seed_error"; grantId: string; reason: string } // shell exists, shred/match threw
  | { action: "error"; reason: string }; // couldn't even establish the grant + monitor row

// Add ONE monitored program: insert the grant shell + its monitor_state row, then shred+match via
// runPipeline over the rendered page + preamble. Idempotent — an already-present source_url is skipped,
// never duplicated.
export async function addSource(db: SupabaseClient, entry: SeedGrant, deps: SeedDeps = {}): Promise<AddResult> {
  const fetchText = deps.fetchText ?? defaultFetchText;
  const pipeline = deps.runPipelineImpl ?? defaultRunPipeline;

  const sourceUrl = seedSourceUrl(entry);
  const existing = await findExistingGrantByUrl(db, sourceUrl);
  if (existing) return { action: "skip_exists", grantId: existing };

  const { data, error } = await db
    .from("grants")
    .insert({ source_url: sourceUrl, title: entry.program, status: "processing" })
    .select("id")
    .single();
  if (error || !data) return { action: "error", reason: error?.message ?? "grant insert failed" };
  const grantId = data.id as string;

  const headless = needsHeadless(entry.url);
  const fetched = await fetchText(entry.url, headless);
  const pageText = fetched.ok ? fetched.text : "";

  // Establish the monitor row (null baseline) BEFORE the shred. If it can't be written, roll the grant
  // shell back so a retry re-seeds cleanly rather than leaving an unmonitored, forever-dedup-skipped
  // orphan (Codex P1).
  const monitored = await insertMonitorState(db, {
    grantId,
    jurisdiction: entry.jurisdiction,
    funderType: entry.funder_type,
    monitorMode: entry.monitor_mode,
    monitorUrl: entry.url,
    seedBatch: SEED_BATCH,
  });
  if (!monitored) {
    await db.from("grants").delete().eq("id", grantId);
    return { action: "error", reason: "monitor_state insert failed" };
  }

  const rawText = buildSeedPreamble(
    { grantor: entry.grantor, program: entry.program, seedText: entry.seed_text, url: entry.url },
    pageText,
  );

  // Shred + match through the existing pipeline, deadline-bounded (a match truncated at the deadline
  // re-queues; the match drain finishes it). Commit the change-detection baseline ONLY on success: a
  // failure leaves a null baseline so the weekly monitor re-derives it (self-heal), and the result is
  // 'seed_error' rather than a false 'seeded' that a re-POST would dedup-skip (Codex P1/P2).
  try {
    await pipeline(grantId, undefined, rawText, db, deps.deadlineMs != null ? { deadlineMs: deps.deadlineMs } : undefined);
    if (fetched.ok) await commitMonitorBaseline(db, grantId, contentHashOf(pageText));
    return { action: "seeded", grantId, fetchOk: fetched.ok };
  } catch (err) {
    const reason = String(err instanceof Error ? err.message : err).slice(0, 600);
    await db.from("grants").update({ status: "error", error_detail: reason }).eq("id", grantId);
    return { action: "seed_error", grantId, reason };
  }
}

// ── dry-run planner ───────────────────────────────────────────────────────────────────────────────
export type PlanResult =
  | { action: "would_seed"; program: string; url: string; headless: boolean; note?: string }
  | { action: "skip_exists"; program: string; url: string; grantId: string };

// What WOULD happen for one entry, writing NOTHING. Reads the dedup index, and — for a verify_url entry
// (or when probeReach is forced) — actually fetches the page so the report can say whether the seeded
// URL is reachable before it goes in. Every other entry skips the fetch to keep the dry-run fast.
export async function planSource(
  db: SupabaseClient,
  entry: SeedGrant,
  deps: SeedDeps = {},
  probeReach = false,
): Promise<PlanResult> {
  const existing = await findExistingGrantByUrl(db, seedSourceUrl(entry));
  if (existing) return { action: "skip_exists", program: entry.program, url: entry.url, grantId: existing };

  const headless = needsHeadless(entry.url);
  let note: string | undefined;
  if (probeReach || entry.tags?.includes("verify_url")) {
    const fetchText = deps.fetchText ?? defaultFetchText;
    const r = await fetchText(entry.url, headless);
    note = r.ok ? `reachable (${r.text.length} chars)` : `UNREACHABLE: ${r.reason}`;
  }
  return { action: "would_seed", program: entry.program, url: entry.url, headless, note };
}
