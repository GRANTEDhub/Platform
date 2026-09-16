import { createServiceClient } from "@/lib/supabase/server";
import { nextDeadlineFrom } from "@/lib/grants/deadline-parse";

// Structured-deadline backfill — the non-protected re-parse sweep that populates grants.deadline so
// genuinely-closed grants stop entering the match pool at the source.
//
// THE PROBLEM. The match-pool gate (loadPool → isGrantOpen → grantLifecycle, lib/grants/lifecycle.ts,
// PROTECTED) reads the STRUCTURED `deadline` DATE column: a null deadline FAILS OPEN (stays in the
// pool). That column is written at ingest by the protected pipeline.ts `parseDeadline`, whose naive
// `new Date(text)` returns null on a prose-wrapped date ("2026 application cycle closed April 30,
// 2026 …" → NaN → null). So a genuinely-CLOSED prose grant lands with deadline=null, fails open, and
// gets scored/surfaced as a live match — the AR-state "fake match" root (RTP).
//
// THE FIX, WITHOUT A PROTECTED EDIT. pipeline.ts's `parseDeadline` is protected, so we cannot upgrade
// the writer. Instead this sweep re-parses `submission_deadline` with the SAME Phase-1 parser
// `nextDeadlineFrom` (strict, latest-future-else-latest-past — NEVER a second parser, which would
// reintroduce the drift Phase 1 killed) and writes the resolved date into `deadline`. The gate then
// sees the real past date → grantLifecycle "closed" → the grant leaves the pool. Forward-fix at the
// data layer; the protected gate and writer are byte-untouched (git diff --stat proves 0 protected).
//
// FILL-NULL ONLY — WRITE-ON-RESOLVE, NEVER NULL-CLOBBER. Two guarantees, both structural:
//   (1) We only ever produce a REAL date to write: `nextDeadlineFrom` returning null is dropped
//       before the candidate set is built, so a null can NEVER overwrite an existing deadline. A
//       rolling / undated / unparseable string stays null (fail-open — correct; a rolling grant
//       SHOULD stay matchable).
//   (2) We only touch rows where `deadline IS NULL` today (the scan filter + the write's re-asserted
//       null-guard). An existing structured deadline — every federal SGG date — is NEVER changed. So
//       this cannot "erase a good federal deadline"; the worst it can do is fill a null with a date.
// The narrower fill-null scope deliberately does NOT re-derive an existing non-null-but-wrong date (a
// false-EARLY-expire — the opposite, rarer bug); that would be a separate `reparse-existing` mode
// behind its own flag, added only if such a false-drop is ever observed.
//
// CLOSED-SWEEP IS UNTOUCHED AND STAYS ON THE LIVE-READ PATH. The DESTRUCTIVE gate (closed-sweep,
// which archives cards) keeps reading `deadlineDaysLeft(submission_deadline)` — a live re-derive from
// free text — NOT this cached column. Only the BENIGN gate (the match pool) reads the cache. A stale
// cache can therefore only ever keep a grant OUT of the scoring pool; it can never drive the
// card-archiving sweep.
//
// The SELECT MUST be non-cached (a stable-URL service-role query — the 2026-07-21 drain-cache
// hazard). createServiceClient already sets cache:"no-store"; the cron/admin routes pass that client.

type DB = ReturnType<typeof createServiceClient>;

// The minimal grant shape the sweep reads. A fuller select is assignable, so callers over-select
// freely. Only rows with deadline IS NULL are ever scanned (the fill-null scope).
export interface BackfillGrantRow {
  id: string;
  title?: string | null;
  submission_deadline: string | null;
  deadline: string | null;
}

// One grant the sweep would write: its submission_deadline resolved to a real date. `past` is whether
// that date is strictly before `now` (a past date is the fake-match fix — it drops the grant from the
// pool; a future date is a no-op for the gate today but keeps the grant expiring correctly LATER).
export interface BackfillCandidate {
  id: string;
  title: string | null;
  submissionDeadline: string;
  resolved: string; // 'YYYY-MM-DD', the date to write into `deadline`
  past: boolean;
}

// The `deadline` column is a DATE ('YYYY-MM-DD'). nextDeadlineFrom returns a UTC-midnight Date, so
// toISOString().slice(0,10) yields the calendar date directly — the SAME shape pipeline.ts's
// parseDeadline writes (parsed.toISOString().slice(0,10)), so the two writers produce identical
// values and never fight over format.
function toDateColumn(d: Date): string {
  return d.toISOString().slice(0, 10);
}

// Pure: from a set of null-deadline grant rows, the ones whose submission_deadline resolves to a real
// date, most-past first (so a capped apply clears the closed grants — the fake-match fixes — before
// the merely-tidying future writes). A row that resolves to null is DROPPED here — this is the
// structural null-clobber guard: a null can never reach the write path.
export function resolveBackfill(rows: BackfillGrantRow[], now: Date = new Date()): BackfillCandidate[] {
  const out: BackfillCandidate[] = [];
  const todayMs = now.getTime();
  for (const r of rows) {
    // Defensive: the scan filters deadline IS NULL, but never write over a non-null deadline even if a
    // row slips through — fill-null is the invariant, enforced at both the query and here.
    if (r.deadline !== null && r.deadline !== undefined) continue;
    const d = nextDeadlineFrom(r.submission_deadline, now);
    if (d === null) continue; // rolling / undated / unparseable → stays null (never clobbered)
    out.push({
      id: r.id,
      title: r.title ?? null,
      submissionDeadline: r.submission_deadline ?? "",
      resolved: toDateColumn(d),
      past: d.getTime() < todayMs,
    });
  }
  // Most-past first: negative "days from now" sorts ahead, so closed grants lead a capped batch.
  return out.sort((a, b) => a.resolved.localeCompare(b.resolved));
}

// Write the resolved date into `deadline` for each candidate, re-asserting `deadline IS NULL` in the
// WHERE so a concurrent ingest that wrote a real date between the scan and this write is NEVER
// overwritten (fill-null holds even under the race). Per-row because each row carries a distinct date.
// Counts rows ACTUALLY updated (the returning select), so a row that got a deadline out from under us
// is silently skipped, not miscounted. Capped by `limit` (most-past first from resolveBackfill).
export async function applyDeadlineBackfill(
  db: DB,
  candidates: BackfillCandidate[],
  opts: { limit?: number } = {},
): Promise<number> {
  const toWrite =
    typeof opts.limit === "number" ? candidates.slice(0, Math.max(0, opts.limit)) : candidates;
  let written = 0;
  for (const c of toWrite) {
    const { data, error } = await db
      .from("grants")
      .update({ deadline: c.resolved })
      .eq("id", c.id)
      .is("deadline", null) // fill-null guard: never overwrite a deadline written since the scan
      .select("id");
    if (error) throw new Error(error.message);
    written += Array.isArray(data) ? data.length : 0;
  }
  return written;
}

export interface BackfillResult {
  scanned: number; // grants read with deadline IS NULL
  resolvable: number; // of those, how many submission_deadline resolves to a real date (would-write)
  staleNull: number; // scanned − resolvable: correctly left null (rolling/undated — the guardrail)
  byDirection: { past: number; future: number }; // resolvable split: past = the fake-match fixes
  written: number; // 0 on a dry run; capped by `limit` on an apply
  remaining: number; // resolvable not written this run (a cap catches them next run)
  sample: BackfillCandidate[]; // bounded, most-past-first preview for the dry-run "look"
}

// Page size for the null-deadline scan. PostgREST caps rows per request, so an unpaginated SELECT
// would silently return only the first page. We page to completeness, ordered by a stable key (id).
const NULL_DEADLINE_PAGE = 1000;

async function fetchNullDeadlineGrants(db: DB, pageSize: number): Promise<BackfillGrantRow[]> {
  const all: BackfillGrantRow[] = [];
  for (let from = 0; ; from += pageSize) {
    const { data, error } = await db
      .from("grants")
      .select("id, title, submission_deadline, deadline")
      .is("deadline", null)
      .order("id", { ascending: true })
      .range(from, from + pageSize - 1);
    if (error) throw new Error(error.message);
    const page = (data ?? []) as unknown as BackfillGrantRow[];
    all.push(...page);
    if (page.length < pageSize) break; // a short page is the last page
  }
  return all;
}

// The driver. Reads every null-deadline grant, resolves the writable subset, and (when `apply`) writes
// up to `limit` of them, most-past first. `apply:false` is a pure read — the dry-run behind the admin
// GET — and writes nothing.
export async function runDeadlineBackfill(
  db: DB,
  opts: {
    apply: boolean;
    limit?: number; // cap on rows WRITTEN this run; undefined = all. Dry runs ignore it.
    now?: Date;
    sampleSize?: number;
    pageSize?: number; // scan page size (default NULL_DEADLINE_PAGE); overridable so a test proves paging
  },
): Promise<BackfillResult> {
  const now = opts.now ?? new Date();
  const rows = await fetchNullDeadlineGrants(db, opts.pageSize ?? NULL_DEADLINE_PAGE);
  const candidates = resolveBackfill(rows, now);
  const past = candidates.filter((c) => c.past).length;
  const byDirection = { past, future: candidates.length - past };
  const sample = candidates.slice(0, opts.sampleSize ?? 25); // already most-past-first

  const base: Omit<BackfillResult, "written" | "remaining"> = {
    scanned: rows.length,
    resolvable: candidates.length,
    staleNull: rows.length - candidates.length,
    byDirection,
    sample,
  };

  if (!opts.apply) {
    return { ...base, written: 0, remaining: candidates.length };
  }

  const written = candidates.length === 0 ? 0 : await applyDeadlineBackfill(db, candidates, { limit: opts.limit });
  return { ...base, written, remaining: candidates.length - written };
}

// The cron kill-switch. Default OFF, and off is byte-identical: the cron route returns before any
// query, so nothing is read or written. Flipping it is a Vercel env change + redeploy (env vars bind
// at build time), not a live toggle. Gates ONLY the automatic sweep — the admin dry-run/apply route
// is deliberately NOT flag-gated (it is the manual "look before you flip" tool).
export function deadlineBackfillEnabled(): boolean {
  return process.env.DEADLINE_BACKFILL_ENABLED === "true";
}
