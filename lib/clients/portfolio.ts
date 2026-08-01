import type { Pipeline } from "@/lib/clients/pipeline";

// The Portfolio roster's triage rule: which clients are asking for something today.
//
// The whole page is built on this one split — a "Requires action" grid of large cards
// and a quieter "No action needed" grid below it — so the rule lives here as a pure
// function rather than inline in the page. It is the page's central claim, and a claim
// that decides what staff look at first should be readable in one place and changeable
// without touching layout.
//
// THE THRESHOLDS ARE THE DESIGN'S, stated in its own legend: alerts ≥ 6, deadline ≤ 30
// days, question waiting. They are named constants because they will get argued with —
// six is a judgement about how big a triage backlog has to be before it is a problem,
// not a fact — and an argument about the number should not require reading JSX.

export const ALERTS_THRESHOLD = 6;
export const DEADLINE_DAYS = 30;

// Ordered by which one gets to speak. A client can trip several at once, and the card
// has room for exactly one reason chip, so this is a priority list rather than a set:
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
// client is quiet and belongs in the lower grid.
export function actionReason(r: PortfolioRollup): ActionReason | null {
  if (r.questions > 0) return "question";
  if (r.deadlineDays !== null && r.deadlineDays <= DEADLINE_DAYS) return "deadline";
  if (r.alerts >= ALERTS_THRESHOLD) return "alerts";
  return null;
}

// A client with no grants at all. Called out separately in the design's lower-grid
// header ("3 have an empty pipeline") because it is a different problem from being
// quiet: quiet means the work is done, empty means no work was ever found, and the
// second one is usually a matching or profile issue rather than good news.
export function hasEmptyPipeline(pipeline: Pipeline): boolean {
  return pipeline.total === 0;
}
