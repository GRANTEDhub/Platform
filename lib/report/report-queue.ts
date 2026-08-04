import { parseAmount, abbrevDollars } from "@/lib/grants/format";
import { staffBucket, type ReportItem, type StaffBucket } from "@/lib/report/shape";

// The Grant Report queue — the list of matched grants awaiting review for one client,
// and the rollups the page header states.
//
// CLOSED-BUT-UNREVIEWED IS THE FINDING THIS SCREEN EXISTS TO SURFACE. A grant whose
// deadline passed while it sat in the queue is not a stale row, it is a miss: matched,
// surfaced, never looked at, and now unwinnable. The old list rendered it identically to
// a live grant — same black date, same card — so nothing ever said it had happened.

export type QueueSort = "deadline" | "fit" | "ceiling";

export interface QueueRow {
  item: ReportItem;
  bucket: StaffBucket;
  // Deadline has already passed. Distinct from `deadlineSoon`, which is explicitly
  // "within 30 days AND not past".
  closed: boolean;
  // Closed AND still awaiting review — the actual miss. A closed grant that was already
  // rejected is just history.
  closedUnreviewed: boolean;
  // The engine's own check-this-first list is non-empty. Drives the concern accent.
  concern: boolean;
  // Award ceiling in dollars, for the combined rollup and the ceiling sort.
  ceiling: number | null;
}

export interface QueueRollup {
  awaiting: number;
  withClient: number;
  pursued: number;
  rejected: number;
  closedUnreviewed: number;
  dueSoon: number;
  avgFit: string | null;
  unscored: number;
  // Summed award ceilings across the AWAITING rows only — the queue in front of you, not
  // the client's whole history. Null when none of them carries a parseable figure;
  // deliberately not $0, which would claim they are worth nothing rather than that we do
  // not know. Estimated ceilings, labelled as such wherever this renders.
  ceiling: string | null;
  ceilingUnpriced: number;
}

export function buildQueue(
  items: ReportItem[],
  opts: { hasReleaseGate: boolean; concernIds?: Set<string>; primaryBucket?: StaffBucket },
): QueueRow[] {
  return items.map((item) => {
    const closed = item.deadlineDaysLeft !== null && item.deadlineDaysLeft < 0;
    const bucket = staffBucket(item, opts.hasReleaseGate);
    return {
      item,
      bucket,
      closed,
      // "Closed without anyone acting on it" -- so it keys on the ACTOR's own queue, not
      // always staff's. For a client that is "client" (in their report, undecided); a
      // deadline that passed while a grant sat there is exactly as worth flagging to them.
      closedUnreviewed: closed && bucket === (opts.primaryBucket ?? "admin"),
      concern: opts.concernIds?.has(item.id) ?? false,
      ceiling: ceilingOf(item),
    };
  });
}

// The ceiling is the TOP of the award range — what the programme will fund at most, which
// is what "ceiling" means on the card. Falls back to the floor when a NOFO publishes only
// a minimum, rather than dropping the grant out of the sum entirely.
function ceilingOf(item: ReportItem): number | null {
  const range = item.awardRange;
  if (!range || range === "—") return null;
  const parts = range.split("–").map((p) => p.trim());
  return parseAmount(parts[parts.length - 1]) ?? parseAmount(parts[0]);
}

// `primary` is the bucket the stats describe -- the actor's own queue, i.e. the grants
// still waiting on THEM. Staff: "admin", the ones not yet released. A client has no
// release gate, so nothing is ever in "admin" for them and every stat would read zero;
// theirs is "client", the ones in their report they have not decided on.
export function rollUpQueue(rows: QueueRow[], primary: StaffBucket = "admin"): QueueRollup {
  const awaiting = rows.filter((r) => r.bucket === primary);
  const scored = awaiting.filter((r) => r.item.fitScore !== null);
  const avg = scored.length
    ? scored.reduce((s, r) => s + (r.item.fitScore ?? 0), 0) / scored.length
    : null;
  const priced = awaiting.filter((r) => r.ceiling !== null);

  return {
    awaiting: awaiting.length,
    withClient: rows.filter((r) => r.bucket === "client").length,
    pursued: rows.filter((r) => r.bucket === "pursued").length,
    rejected: rows.filter((r) => r.bucket === "rejected").length,
    closedUnreviewed: rows.filter((r) => r.bucket === primary && r.closed).length,
    dueSoon: awaiting.filter((r) => r.item.deadlineSoon).length,
    avgFit: avg === null ? null : avg.toFixed(1),
    unscored: awaiting.length - scored.length,
    ceiling: priced.length ? abbrevDollars(priced.reduce((s, r) => s + (r.ceiling ?? 0), 0)) : null,
    ceilingUnpriced: awaiting.length - priced.length,
  };
}

// Sort comparators. Closed rows float to the TOP of every sort rather than sinking:
// they are the thing the screen is trying to make impossible to miss, and burying them
// at the bottom of a nine-row list is how they went unnoticed in the first place.
export function sortQueue(rows: QueueRow[], sort: QueueSort): QueueRow[] {
  const rank = (r: QueueRow) => (r.closedUnreviewed ? 0 : 1);
  const byDeadline = (a: QueueRow, b: QueueRow) => {
    const ad = a.item.deadlineDaysLeft;
    const bd = b.item.deadlineDaysLeft;
    if (ad === bd) return a.item.title.localeCompare(b.item.title);
    // Undated last — "no deadline" is the absence of a clock, not urgency.
    if (ad === null) return 1;
    if (bd === null) return -1;
    return ad - bd;
  };
  const cmp: Record<QueueSort, (a: QueueRow, b: QueueRow) => number> = {
    deadline: byDeadline,
    // Unscored below every scored card, for the same reason as toReportItems.
    fit: (a, b) => (b.item.fitScore ?? -1) - (a.item.fitScore ?? -1) || byDeadline(a, b),
    ceiling: (a, b) => (b.ceiling ?? -1) - (a.ceiling ?? -1) || byDeadline(a, b),
  };
  return [...rows].sort((a, b) => rank(a) - rank(b) || cmp[sort](a, b));
}
