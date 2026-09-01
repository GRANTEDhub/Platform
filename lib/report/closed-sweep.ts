import { createServiceClient } from "@/lib/supabase/server";
import { deadlineDaysLeft } from "@/lib/report/shape";

// Auto-archive of grants whose submission deadline has strictly passed — the "freshness"
// half of surfacing. A closed grant is dead: it must not sit in a client's (or staff's)
// LIVE list looking like a live opportunity. This is the shared core behind three callers:
//   - the staff manual bulk sweep + the single-card overdue gate (app/api/review/archive-closed)
//   - the automatic all-clients cron (app/api/cron/closed-sweep, flag CLOSED_SWEEP_ENABLED)
//   - the admin dry-run / first-backfill tool (app/api/admin/closed-sweep)
// One definition of "closed" and one write shape, so the manual and automatic paths cannot drift.
//
// DEAD-STATE, NEVER HIDE. Archiving records decision='passed' with an honest reason; the card
// leaves the live tab and lands in the reversible "Passed" bucket (kept, not deleted — a decision
// can be changed later). review_cards has no suppress/delete here — a swept card is still reachable.
//
// STRICT `< 0`, FAIL-OPEN. "Closed" is `deadlineDaysLeft(...) < 0` — the SAME function (and the
// same strict boundary) the verdict paragraph's `closed` hard-kill, buildQueue's `closed`, and the
// overdue gate all use, so the surfacing sweep and the detail hard-kill can never disagree. A grant
// due TODAY (days === 0) is still winnable (federal deadlines carry a cut-off time we do not store)
// and is NEVER swept; a rolling / TBD / unparseable / undated deadline yields null and is NEVER
// swept. Only a real parseable date strictly in the past qualifies.
//
// NO CALIBRATION SIGNAL, EVER — for either reason group. A missed deadline is a fact about our
// capacity / the clock, NOT a scorer error; writing a match_feedback row would teach the engine to
// stop surfacing a grant type it was right to surface. This core writes ONLY the review_cards
// decision update, and the unit test asserts zero match_feedback writes on a released-inclusive run.

type DB = ReturnType<typeof createServiceClient>;

// The two honest reasons, split on the SME release gate (0059). A card the client had already SEEN
// (released) is not a "closed before review" miss — somebody reviewed it and released it, and then
// the deadline ran out. Same strings the manual archive route has always written.
export const REASON_UNREVIEWED = "Closed before review";
export const REASON_RELEASED = "Deadline passed after release";

// A minimal shape of a review_cards row + its joined grant. Any fuller select is assignable, so
// callers over-select freely. `grants` may arrive as an object (the FK embed) or a one-element
// array depending on the query — normalized below, exactly as the archive route does.
export interface SweepCardRow {
  id: string;
  client_id?: string | null;
  decision: string;
  sme_released_at: string | null;
  card_type?: string | null;
  grants:
    | { title?: string | null; submission_deadline: string | null }
    | { title?: string | null; submission_deadline: string | null }[]
    | null;
}

// One card the sweep would archive, with the fields the dry-run "look" needs.
export interface EligibleCard {
  cardId: string;
  clientId: string | null;
  released: boolean; // sme_released_at set — the sensitive "client was actively holding it" case
  daysAgo: number; // whole days since the deadline (always > 0 here)
  grantTitle: string | null;
}

function normGrant(g: SweepCardRow["grants"]): { title?: string | null; submission_deadline: string | null } | null {
  return Array.isArray(g) ? (g[0] ?? null) : g;
}

// Which of the handed rows are genuinely closed-and-archivable, most-overdue first.
//
// A row qualifies when: its deadline is a real date strictly in the past (`days < 0`), it is still
// undecided (`decision === 'pending'` — a closed grant already rejected is history, not a miss), it
// is not a prospect card, and — unless `includeReleased` — it has NOT been released to the client.
// The `card_type !== 'prospect'` check is defensive: both DB callers also filter it in SQL, and a
// row that never selected the column (undefined) passes, since it was already filtered upstream.
export function closedSweepEligible(
  rows: SweepCardRow[],
  opts: { includeReleased: boolean },
): EligibleCard[] {
  const out: EligibleCard[] = [];
  for (const r of rows) {
    if (r.decision !== "pending") continue;
    if (r.card_type === "prospect") continue;
    const released = r.sme_released_at !== null && r.sme_released_at !== undefined;
    if (released && !opts.includeReleased) continue;
    const g = normGrant(r.grants);
    const days = deadlineDaysLeft(g?.submission_deadline);
    // Strict `< 0`, fail-open: null (rolling/TBD/unparseable) and 0 (due today) are NOT closed.
    if (days === null || days >= 0) continue;
    out.push({
      cardId: r.id,
      clientId: r.client_id ?? null,
      released,
      daysAgo: Math.abs(days),
      grantTitle: g?.title ?? null,
    });
  }
  // Most-overdue first so a capped run clears the stalest cards before the fresher ones.
  return out.sort((a, b) => b.daysAgo - a.daysAgo);
}

// Write the terminal 'passed' decision for the eligible cards, grouped by reason. At most two
// statements however large the batch (the two reasons), so this stays cheap. NEVER writes
// match_feedback. Returns the number of cards archived, or throws the DB error.
export async function applyClosedSweep(
  db: DB,
  cards: EligibleCard[],
  opts: { decidedBy: string | null; now?: () => number },
): Promise<number> {
  const decidedAt = new Date(opts.now?.() ?? Date.now()).toISOString();
  const groups: { ids: string[]; reason: string }[] = [
    { ids: cards.filter((c) => !c.released).map((c) => c.cardId), reason: REASON_UNREVIEWED },
    { ids: cards.filter((c) => c.released).map((c) => c.cardId), reason: REASON_RELEASED },
  ];
  let archived = 0;
  for (const g of groups) {
    if (g.ids.length === 0) continue;
    const { data, error } = await db
      .from("review_cards")
      .update({
        decision: "passed",
        decision_reason: g.reason,
        decided_by: opts.decidedBy,
        // A staff-side system action. decided_by is null on the automatic (cron) path; the reason
        // carries the account of what happened. Never "client" — this is our sweep, not their pass.
        decided_by_actor: "staff",
        decided_at: decidedAt,
      })
      // OPTIMISTIC-CONCURRENCY GUARD: the write re-asserts `decision = 'pending'` in its own WHERE, so
      // a staff or client decision made between the eligibility read and this write (the hourly
      // all-client cron makes that race real with no human in the loop) is PRESERVED, never clobbered
      // with 'passed'. `archived` counts the rows ACTUALLY updated (the returning select), not the ids
      // we asked for — a card decided out from under us is silently skipped, not miscounted.
      .eq("decision", "pending")
      .in("id", g.ids)
      .select("id");
    if (error) throw new Error(error.message);
    archived += Array.isArray(data) ? data.length : 0;
  }
  return archived;
}

export interface SweepResult {
  scanned: number; // pending non-prospect cards read
  eligible: number; // of those, closed-and-archivable
  byReason: { closedBeforeReview: number; deadlinePassedAfterRelease: number };
  archived: number; // 0 on a dry run; capped by `limit` on an apply
  remaining: number; // eligible not archived this run (a cap will catch them next run)
  sample: EligibleCard[]; // a bounded, most-overdue-first preview for the dry-run "look"
}

// Default page size for the pending-card scan. PostgREST caps rows per request (Supabase's default
// max-rows), so an unpaginated SELECT would silently return only the first page — and since the
// deadline is free-text (JS-parsed, not SQL-filterable) and future/undated pending cards stay pending
// forever, those could fill page one while closed cards beyond it are never discovered. We page to
// completeness instead.
const PENDING_PAGE = 1000;

// Read EVERY pending non-prospect card (+ its grant deadline), paged to completeness. Ordered by a
// stable key (id) so the ranges don't skip/duplicate across pages. The deadline can't be filtered in
// SQL (free text), so eligibility is derived in JS by the caller from the full set.
async function fetchPendingCards(db: DB, pageSize: number): Promise<SweepCardRow[]> {
  const all: SweepCardRow[] = [];
  for (let from = 0; ; from += pageSize) {
    const { data, error } = await db
      .from("review_cards")
      .select("id, client_id, decision, sme_released_at, card_type, grants(title, submission_deadline)")
      .eq("decision", "pending")
      .neq("card_type", "prospect")
      .order("id", { ascending: true })
      .range(from, from + pageSize - 1);
    if (error) throw new Error(error.message);
    const page = (data ?? []) as unknown as SweepCardRow[];
    all.push(...page);
    if (page.length < pageSize) break; // a short page is the last page
  }
  return all;
}

// The all-clients driver. Reads every pending non-prospect card + its grant deadline, derives the
// eligible set, and (when `apply`) archives up to `limit` of them, most-overdue first. `apply:false`
// is a pure read — the dry-run behind the admin GET — and writes nothing.
//
// The SELECT MUST be non-cached: it is a stable-URL query on a service-role client, exactly the
// shape Next's Data Cache silently froze in the 2026-07-21 drain incident. createServiceClient
// already sets cache:"no-store"; callers must pass that client (the cron/admin routes do).
export async function runClosedSweep(
  db: DB,
  opts: {
    includeReleased: boolean;
    apply: boolean;
    limit?: number; // cap on cards WRITTEN this run; undefined = all. Dry runs ignore it.
    decidedBy?: string | null;
    now?: () => number;
    sampleSize?: number;
    pageSize?: number; // scan page size (default PENDING_PAGE); overridable so a test can prove paging
  },
): Promise<SweepResult> {
  const rows = await fetchPendingCards(db, opts.pageSize ?? PENDING_PAGE);
  const eligible = closedSweepEligible(rows, { includeReleased: opts.includeReleased });
  const released = eligible.filter((c) => c.released).length;
  const byReason = {
    closedBeforeReview: eligible.length - released,
    deadlinePassedAfterRelease: released,
  };
  const sampleSize = opts.sampleSize ?? 25;
  // The sample leads with the RELEASED cards — the actively-held ones staff most want to eyeball
  // before enabling the sweep — then fills with unreviewed, capped.
  const sample = [
    ...eligible.filter((c) => c.released),
    ...eligible.filter((c) => !c.released),
  ].slice(0, sampleSize);

  if (!opts.apply) {
    return { scanned: rows.length, eligible: eligible.length, byReason, archived: 0, remaining: eligible.length, sample };
  }

  const toApply = typeof opts.limit === "number" ? eligible.slice(0, Math.max(0, opts.limit)) : eligible;
  const archived = toApply.length === 0 ? 0 : await applyClosedSweep(db, toApply, { decidedBy: opts.decidedBy ?? null, now: opts.now });
  return { scanned: rows.length, eligible: eligible.length, byReason, archived, remaining: eligible.length - archived, sample };
}

// The cron kill-switch. Default OFF, and off is byte-identical: the cron route returns before any
// query, so nothing is read or written. Flipping it is a Vercel env change + redeploy (env vars bind
// at build time), not a live toggle. Gates ONLY the automatic sweep — the staff manual archive
// button and the admin route are unaffected.
export function closedSweepEnabled(): boolean {
  return process.env.CLOSED_SWEEP_ENABLED === "true";
}
