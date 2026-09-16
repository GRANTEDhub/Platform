// The Grant Prospecting feed's VIEW-LAYER preparation (app/(app)/intel/grants): drop dead
// grants, then order what's left.
//
// TWO problems, both view-layer, both leaving gate.ts (a PROTECTED file) untouched — the feed
// still arrives ingested_at-desc and we reshape the returned array in the (non-protected) page,
// the lib/report/paused-filter.ts precedent. ProspectFeedItem carries no `ingested_at`, so this
// keys only on the fields it DOES carry — the deadline, surfaced prospects, and client matches.
//
// 1. FILTER OUT genuinely-expired grants. A grant whose submission deadline has strictly passed
//    can't be pursued — it's noise in a live prospecting list. It is DROPPED from the feed.
//    CRITICAL PRECISION: only a REAL negative day count expires (deadlineDaysLeft < 0). A rolling
//    / always-open / undated / unparseable deadline returns deadlineDaysLeft === null and is NEVER
//    expired — it STAYS. A large share of the AR state repository is rolling / always-open, so
//    filtering nulls would nuke it. negative = out; null = stays. (This is a view filter only;
//    see the auto-expire note at the bottom — nothing removes these at the source today.)
//
// 2. SORT the survivors (Shannon's option B). A single ingest batch shares ONE ingested_at — the
//    ~40 AR state-scrub grants (#532) all landed together — so gate.ts's `ingested_at DESC` piled
//    that whole batch into a contiguous block at the TOP regardless of merit, walling off older
//    rows. The re-sort breaks the wall: grants with a live thread (a surfaced prospect OR a client
//    match) lead, then by deadline urgency — live-dated soonest-first, rolling/undated after
//    (nulls last). Node's Array.sort is stable, so the incoming ingested_at-desc order survives as
//    the final tiebreak within an equal key.
//
// Pure + unit-tested so the filter and the ordering are verified without the async server page.

import type { ProspectFeedItem } from "@/lib/grants/gate";
import { deadlineDaysLeft } from "@/lib/report/shape";

// GENUINELY expired: a real negative day count. deadlineDaysLeft returns null for a rolling /
// undated / unparseable deadline, and that null is NEVER expired (it stays in the feed). The
// null-guard is load-bearing: `null < 0` is false in JS, but we assert the intent explicitly so
// no future refactor can let a rolling grant read as expired.
export function isExpiredFeedItem(item: ProspectFeedItem): boolean {
  const days = deadlineDaysLeft(item.grant.submission_deadline);
  return days !== null && days < 0;
}

// A grant is actionable when it has a live thread: at least one surfaced prospect OR at least one
// client match. Literal to the option-B definition — any client match counts, whatever the client
// decided, because a scored match is still context on the grant.
export function isActionableFeedItem(item: ProspectFeedItem): boolean {
  return item.prospectCards.length > 0 || item.clientMatches.length > 0;
}

// Deadline ordering as (bucket, days): live-dated (bucket 0, soonest first) < rolling/undated
// (bucket 1) < already-passed (bucket 2). Only live grants sort by their day count; rolling and
// passed grants carry days=0 so they hold the stable ingested_at-desc order within their bucket.
// In the composed prepareProspectFeed path a passed grant is filtered out BEFORE the sort, so
// bucket 2 never fires there; it stays as a defensive fallback so a bare sortProspectFeed call on
// unfiltered rows sinks a dead grant to the bottom rather than floating it to the top.
export function deadlineRank(item: ProspectFeedItem): { bucket: 0 | 1 | 2; days: number } {
  const days = deadlineDaysLeft(item.grant.submission_deadline);
  if (days === null) return { bucket: 1, days: 0 }; // rolling / TBD / unparseable -> nulls last
  if (days < 0) return { bucket: 2, days: 0 }; // already passed -> sink (fallback; normally filtered)
  return { bucket: 0, days }; // live: soonest deadline first
}

// Sort a feed by option B. Returns a sorted COPY; never mutates the input.
export function sortProspectFeed(feed: ProspectFeedItem[]): ProspectFeedItem[] {
  return [...feed].sort((a, b) => {
    const aAct = isActionableFeedItem(a);
    const bAct = isActionableFeedItem(b);
    if (aAct !== bAct) return aAct ? -1 : 1;
    const ra = deadlineRank(a);
    const rb = deadlineRank(b);
    if (ra.bucket !== rb.bucket) return ra.bucket - rb.bucket;
    return ra.days - rb.days;
  });
}

// The page's single entry point: drop genuinely-expired grants, then sort the rest by option B.
export function prepareProspectFeed(feed: ProspectFeedItem[]): ProspectFeedItem[] {
  return sortProspectFeed(feed.filter((item) => !isExpiredFeedItem(item)));
}
