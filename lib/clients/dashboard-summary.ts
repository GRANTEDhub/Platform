import { abbrevDollars, parseAmount } from "@/lib/grants/format";
import { stageOf, type PipelineCard, type PipelineStageKey } from "@/lib/clients/pipeline";

// The client masthead's pipeline rollup: how many grants sit at each stage, and roughly
// how much money is attached to them.
//
// MONEY HERE IS AN ESTIMATE OF AN ESTIMATE and is labelled as one everywhere it renders.
// Each grant carries an award RANGE (`award_range_min` / `award_range_max`), which is the
// size of one award under that program — not what this client would receive, and often
// itself flagged `award_range_is_estimate`. Summing the ceilings across a stage answers
// "how much is notionally on the table here", which is the question the masthead is for,
// and answers nothing more precise than that. The alternative — omitting money because it
// cannot be exact — loses the only sense of scale the page has.
//
// WHY THE CEILING and not the floor or the midpoint: the figure reads as "up to", which is
// the honest framing for a pipeline that has not been applied to. A midpoint would imply a
// precision the underlying range does not have.

export interface StageRollup {
  key: PipelineStageKey;
  label: string;
  count: number;
  // Summed award ceilings for this stage, or null when no grant at this stage carries a
  // parseable figure. Null renders as a dash — deliberately NOT $0, which would claim
  // the grants are worth nothing rather than that we do not know.
  dollars: number | null;
  money: string | null;
}

export interface BookRollup {
  stages: StageRollup[];
  total: number;
  // Share of this client's grants that have been looked at — everything past triage,
  // including passed. "Assessed" is about whether a human made a call, not whether the
  // call was yes. 0 when there is nothing to assess.
  assessedPct: number;
  // Grants with no parseable award figure. Surfaced so the estimate marker can say how
  // much of the book it is silent about instead of quietly under-reporting.
  unpriced: number;
  // True when ANY contributing grant is flagged award_range_is_estimate. In practice
  // almost always true; kept as a real read rather than a hardcoded "est." so the day a
  // roster is fully NOFO-confirmed the marker actually drops.
  hasEstimates: boolean;
}

// Order matters — it is the funnel, and the masthead reads left to right.
const ORDER: { key: PipelineStageKey; label: string }[] = [
  { key: "triage", label: "Unassessed" },
  { key: "client", label: "With client" },
  { key: "approved", label: "Approved" },
  { key: "pursuit", label: "In pursuit" },
  { key: "passed", label: "Passed" },
];

// The award columns this needs, flattened off the embedded grant by the caller.
export interface PricedCard extends PipelineCard {
  awardMax: string | null;
  awardMin: string | null;
  awardIsEstimate: boolean | null;
}

export function rollUpClient(cards: PricedCard[]): BookRollup {
  const counts = { triage: 0, client: 0, approved: 0, pursuit: 0, passed: 0 } as Record<PipelineStageKey, number>;
  const dollars = { triage: 0, client: 0, approved: 0, pursuit: 0, passed: 0 } as Record<PipelineStageKey, number>;
  const priced = { triage: 0, client: 0, approved: 0, pursuit: 0, passed: 0 } as Record<PipelineStageKey, number>;
  let unpriced = 0;
  let hasEstimates = false;

  for (const c of cards) {
    const k = stageOf(c);
    counts[k] += 1;
    // Ceiling first, floor as the fallback: a grant that publishes only a minimum is
    // still worth counting at that minimum rather than dropping out of the sum.
    const n = parseAmount(c.awardMax) ?? parseAmount(c.awardMin);
    if (n === null) {
      unpriced += 1;
      continue;
    }
    dollars[k] += n;
    priced[k] += 1;
    if (c.awardIsEstimate) hasEstimates = true;
  }

  const total = cards.length;
  const assessed = total - counts.triage;

  return {
    stages: ORDER.map(({ key, label }) => ({
      key,
      label,
      count: counts[key],
      dollars: priced[key] > 0 ? dollars[key] : null,
      money: priced[key] > 0 ? abbrevDollars(dollars[key]) : null,
    })),
    total,
    assessedPct: total > 0 ? Math.round((assessed / total) * 100) : 0,
    unpriced,
    hasEstimates,
  };
}
