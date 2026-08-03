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

// ── The CLIENT's own funnel ──────────────────────────────────────────────────
// Same BookRollup shape so the masthead renders it with no special casing, but built from
// the client's predicates and labelled in their language.
//
// FOUR STAGES, NOT FIVE, and the difference is the whole point. The console's leading
// stage is `triage` = "unassessed" = pending OUR review, which is precisely the thing a
// client must not be shown. Theirs starts one step later, at the alerts we have sent them
// and they have not opened yet.
//
// Reuses the console's stage KEYS rather than inventing new ones, because the keys are
// what index STAGE_ON_INK — so the client's bar gets the same monotonic ramp, with the
// leading stage in orange for the same reason it is orange on the console: it is the one
// that is owed. `pursuit` is deliberately unused; a client does not distinguish
// "approved" from "routed", so both fold into Approved and the empty stage drops out of
// the bar (segments filter on count > 0).
//
// NO MONEY. Award ceilings are program-level maxima, and a client reading "$31M" against
// their own name would read it as theirs. dollars/money stay null, which the masthead
// already renders as a dash, and unpriced stays 0 so the "N unpriced" clause never fires.
const PORTAL_ORDER: { key: PipelineStageKey; label: string }[] = [
  { key: "triage", label: "Alerts to review" },
  { key: "client", label: "In your report" },
  { key: "approved", label: "Approved" },
  { key: "passed", label: "Passed" },
];

export interface PortalStageCard {
  decision: PipelineCard["decision"];
  interested_at: string | null;
}

export function rollUpPortal(cards: PortalStageCard[]): BookRollup {
  const counts: Record<PipelineStageKey, number> = {
    triage: 0,
    client: 0,
    approved: 0,
    pursuit: 0,
    passed: 0,
  };

  for (const c of cards) {
    // Order mirrors stageOf: terminal first, so a card that has advanced is never
    // reported at an earlier stage.
    if (c.decision === "passed") counts.passed += 1;
    else if (c.decision === "approved") counts.approved += 1;
    else if (c.interested_at !== null) counts.client += 1;
    else counts.triage += 1;
  }

  const total = cards.length;
  return {
    stages: PORTAL_ORDER.map(({ key, label }) => ({
      key,
      label,
      count: counts[key],
      dollars: null,
      money: null,
    })),
    total,
    // Everything past their own alerts queue: what they have actually looked at. Same
    // meaning as the console's figure, measured from their side of the handoff.
    assessedPct: total > 0 ? Math.round(((total - counts.triage) / total) * 100) : 0,
    unpriced: 0,
    hasEstimates: false,
  };
}
