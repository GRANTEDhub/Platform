import type { Pipeline, PipelineStageKey } from "@/lib/clients/pipeline";

// The Portfolio roster's triage rule: which clients are asking for something today.
//
// The whole page is built on this one split — a "Requires action" grid of large cards
// and a quieter index below it — so the rule lives here as a pure function rather than
// inline in the page. It is the page's central claim, and a claim that decides what
// staff look at first should be readable in one place and changeable without touching
// layout.
//
// THE THRESHOLDS ARE THE DESIGN'S, stated in its own legend: alerts >= 6, deadline <= 30
// days, question waiting. They are CONFIG rather than literals because they will get
// argued with — six is a judgement about how big a triage backlog has to be before it is
// a problem, not a fact — and losing that argument should not cost a deploy.

// Read a positive integer from the environment, falling back to the design's value.
//
// Anything unparseable or <= 0 falls back rather than throwing: a typo in a Vercel env
// var must not take the roster down, and a threshold of 0 would put every client in the
// action grid, which is the same as having no split at all.
function threshold(name: string, fallback: number): number {
  const n = Number.parseInt(process.env[name] ?? "", 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

// Cards awaiting review before a client counts as backlogged.
export const ALERTS_THRESHOLD = threshold("PORTFOLIO_ALERTS_THRESHOLD", 6);
// Days to the nearest deadline before the clock counts as running.
export const DEADLINE_DAYS = threshold("PORTFOLIO_DEADLINE_DAYS", 30);

// Ordered by which one gets to speak. A client can trip several at once, and the card
// has room for exactly one reason strip, so this is a priority list rather than a set:
//   question  someone is waiting on a human answer — the only reason that is a person
//   deadline  a clock is running and cannot be paused
//   alerts    a backlog, which is real work but is not time-boxed
export type ActionReason = "question" | "deadline" | "alerts";

export interface PortfolioRollup {
  // Cards awaiting review. SAME predicate as /matches and the command band's badge
  // (non-prospect, non-passed, not yet released) so the three surfaces cannot disagree
  // about how much is waiting on a client.
  alerts: number;
  // Whole days to the client's nearest grant deadline; null when they have none.
  // Negative means overdue, which still counts as inside the window.
  deadlineDays: number | null;
  // Client questions awaiting an answer.
  //
  // ALWAYS 0 TODAY. There is no question store in the schema — in-app messaging is not
  // built. The reason is wired through anyway, deliberately: the design draws both an
  // active and an inactive state for it, so the inactive one is honest to ship, and
  // when questions land this becomes a real count with no layout change. What is NOT
  // done is fabricating the count to make the design's sample roster reproduce.
  questions: number;
}

// Which reason, if any, puts this client in the requires-action group. Null means the
// client is quiet and belongs in the index below.
export function actionReason(r: PortfolioRollup): ActionReason | null {
  if (r.questions > 0) return "question";
  if (r.deadlineDays !== null && r.deadlineDays <= DEADLINE_DAYS) return "deadline";
  if (r.alerts >= ALERTS_THRESHOLD) return "alerts";
  return null;
}

// A client with no grants at all. Called out separately because it is a different
// problem from being quiet: quiet means the work is done, empty means no work was ever
// found, and the second one is usually a matching or profile issue rather than good news.
export function hasEmptyPipeline(pipeline: Pipeline): boolean {
  return pipeline.total === 0;
}

// ── Book-level rollup ───────────────────────────────────────────────────────
// The masthead's pipeline bar: the same five stages as one client's mini bar, summed
// across the whole roster.
//
// FIVE segments, not the four the mockup draws. The design's legend shows
// unassessed / approved / in pursuit / passed and omits the released-to-client stage,
// which its sample roster happened to have empty. Dropping a real stage would make the
// segments stop summing to the stated total, and "125 grants" sitting above bars that
// add to fewer than 125 is worse than a legend with one more entry.
export interface BookPipeline {
  counts: Record<PipelineStageKey, number>;
  total: number;
  // Share of the book never triaged, as a whole percent. The design's "75% never
  // looked at" — the one number on the page that is about the firm rather than a
  // client. 0 when the book is empty (rather than NaN).
  unassessedPct: number;
}

export function rollUpBook(pipelines: Pipeline[]): BookPipeline {
  const counts = { triage: 0, client: 0, approved: 0, pursuit: 0, passed: 0 } as Record<PipelineStageKey, number>;
  let total = 0;
  for (const p of pipelines) {
    for (const s of p.stages) counts[s.key] += s.count;
    total += p.total;
  }
  return { counts, total, unassessedPct: total > 0 ? Math.round((counts.triage / total) * 100) : 0 };
}
