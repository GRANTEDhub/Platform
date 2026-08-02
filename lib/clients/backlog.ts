// The backlog sparkline: how the unassessed count has moved over the last eight weeks.
//
// THIS NEEDS NO SNAPSHOT TABLE, which reverses what the Portfolio pass concluded. That
// pass assumed a trend needs history nobody stores, and for a general metric it would.
// But the unassessed count specifically is reconstructable, because both of its edges are
// already timestamped by the paths that do the work:
//
//   a card ENTERS the backlog when the engine first cards it   -> match_attempts.created_at
//   a card LEAVES when anyone first acts on it                 -> the earliest of
//                                                                 interested_at,
//                                                                 sme_released_at,
//                                                                 sent_at, decided_at
//
// Given an interval per card, the count at any past instant is just how many intervals
// span it. So this is a real reconstruction of a real series, not an approximation and
// not a placeholder.
//
// TWO HONEST LIMITS, both of which understate rather than invent:
//   · A card with no carded attempt (a manual add — it never went through the engine) has
//     no entry time and is left out of the history entirely. `unplaceable` reports how
//     many, so the caller can decline to draw a trend built on too little.
//   · Deleted cards are gone, so the series describes the backlog as it looks in hindsight
//     from today's rows. Nothing in the product hard-deletes review_cards, so in practice
//     this is theoretical.

export const BACKLOG_WEEKS = 8;
const WEEK_MS = 7 * 86_400_000;

export interface BacklogCard {
  // When the engine first carded this pair. Null when there is no carded attempt.
  enteredAt: string | null;
  // When it first stopped being untriaged. Null while it is still in the backlog.
  leftAt: string | null;
}

// Below this many weeks with anything in the backlog there is no shape to draw — the
// chart would be one spike and seven baselines, which says less than the count already
// above it does.
export const MIN_NONZERO_WEEKS = 3;

export interface BacklogTrend {
  // Oldest first, one per week, ending with the count as of now.
  points: number[];
  // Percent change from the first point to the last. Null when the series starts at zero
  // — a percentage against zero is not a number, and "+∞%" is not a trend.
  pctChange: number | null;
  // Absolute change, always available. Used when pctChange is null.
  absChange: number;
  // Cards that could not be placed in time (no carded attempt).
  unplaceable: number;
  // Whether the series has enough shape to be worth drawing. A trend is a claim about
  // movement; a single spike at the right-hand end is not one.
  drawable: boolean;
}

// The earliest of a card's exit markers, or null while it is still untriaged. Earliest
// rather than latest: the backlog is about being UNTOUCHED, so the first act of any kind
// is what takes a card out of it — the same reasoning as the pipeline's `alerted()`.
export function leftTriageAt(c: {
  interested_at: string | null;
  sme_released_at: string | null;
  sent_at: string | null;
  decided_at: string | null;
}): string | null {
  const times = [c.interested_at, c.sme_released_at, c.sent_at, c.decided_at]
    .filter((t): t is string => t !== null)
    .map((t) => Date.parse(t))
    .filter((n) => Number.isFinite(n));
  if (times.length === 0) return null;
  return new Date(Math.min(...times)).toISOString();
}

export function deriveBacklog(cards: BacklogCard[], now: number): BacklogTrend {
  const spans: { in: number; out: number }[] = [];
  let unplaceable = 0;

  for (const c of cards) {
    const entered = c.enteredAt ? Date.parse(c.enteredAt) : NaN;
    if (!Number.isFinite(entered)) {
      unplaceable += 1;
      continue;
    }
    const leftRaw = c.leftAt ? Date.parse(c.leftAt) : NaN;
    // A left-time before the entry time is a data oddity (a manual override recorded
    // against a pair the engine carded later); clamp rather than produce a negative-width
    // interval that would drop the card out of every bucket.
    const out = Number.isFinite(leftRaw) ? Math.max(leftRaw, entered) : Number.POSITIVE_INFINITY;
    spans.push({ in: entered, out });
  }

  const points: number[] = [];
  for (let k = BACKLOG_WEEKS - 1; k >= 0; k--) {
    const t = now - k * WEEK_MS;
    points.push(spans.filter((s) => s.in <= t && s.out > t).length);
  }

  const first = points[0];
  const last = points[points.length - 1];
  return {
    points,
    pctChange: first > 0 ? Math.round(((last - first) / first) * 100) : null,
    absChange: last - first,
    unplaceable,
    drawable: points.filter((n) => n > 0).length >= MIN_NONZERO_WEEKS,
  };
}
