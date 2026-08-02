import type { PipelineStageKey } from "@/lib/clients/pipeline";

// The IntellEngine ambient note — the observation at the foot of "Needs your attention".
//
// DETERMINISTIC, NOT GENERATED. The design's requirement is that the note names actual
// records — counts, program names, agencies — and never offers generic advice, because a
// single vague note destroys the credibility of every real one. A rule that fires only
// when it finds a specific, checkable pattern satisfies that by construction: it cannot
// invent a cluster that is not there, and it cannot be confidently wrong about a number.
// A model on the render path could do both, could not be tested from a sandbox, and would
// put an LLM call in the critical path of a page load.
//
// The tradeoff is honest: this notices fewer things than a model would. The two rules
// below are the two whose inputs exist today. Rejection-pattern detection ("you keep
// passing on rural set-asides") needs clustering over free-text decision_reason and is a
// genuine model problem — it is not faked here in the meantime.
//
// RENDERS NOTHING WHEN THERE IS NOTHING TO SAY. There is deliberately no fallback note.
// "No insights right now" is the exact failure this design is guarding against.

export interface AmbientNoteInput {
  // Every non-passed card, with just the fields the rules read.
  cards: {
    id: string;
    stage: PipelineStageKey;
    funder: string | null;
    deadlineDays: number | null;
  }[];
  // Whether this client has any IntellEngine draft in flight. Drives the staleness rule:
  // an approved grant with a clock on it and no draft anywhere is the finding.
  hasDraft: boolean;
  // Where "score these" goes.
  triageHref: string;
  // Where "start the draft" goes.
  intellEngineHref: string;
  // How many other rows the attention card is already showing. The note is the lowest-
  // priority thing on the card and is suppressed rather than pushing the page over its
  // height budget.
  otherRows: number;
}

export interface AmbientNote {
  // One sentence. Names real records; never generic.
  body: string;
  action: { label: string; href: string };
}

// Past this many other attention rows the note is suppressed — it is the least urgent
// item on the card, and the card is what keeps the left column inside 900px.
export const MAX_ROWS_BEFORE_SUPPRESS = 4;

// A deadline this close, on an approved grant with no draft started, is the staleness
// finding. Wider than the report card's 7-day urgency marker on purpose: this is about
// having time to DO something, not about the deadline being imminent.
const STALE_DEADLINE_DAYS = 45;

// Below this, a "cluster" is just a coincidence and saying so is noise.
const MIN_CLUSTER = 3;

function plural(n: number, one: string, many: string) {
  return `${n} ${n === 1 ? one : many}`;
}

// A normalised funder key. Agencies arrive with inconsistent casing and trailing
// qualifiers across sources, so grouping on the raw string splits real clusters.
function funderKey(f: string | null): string | null {
  const s = (f ?? "").trim().toLowerCase();
  return s.length > 1 ? s : null;
}

export function deriveAmbientNote(input: AmbientNoteInput): AmbientNote | null {
  if (input.otherRows >= MAX_ROWS_BEFORE_SUPPRESS) return null;

  const { cards } = input;

  // ── Rule 1: clustering ────────────────────────────────────────────────────
  // Unassessed grants from the same funder as something already in pursuit. This is the
  // highest-value note because it turns a pile of 16 into a ranked 3: the work of judging
  // fit has already been done once for that funder, so those three are the cheapest to
  // score and the likeliest to land.
  const pursuing = cards.filter((c) => c.stage === "pursuit" || c.stage === "approved");
  const pursuedFunders = new Set(pursuing.map((c) => funderKey(c.funder)).filter((k): k is string => k !== null));
  const unassessed = cards.filter((c) => c.stage === "triage");

  if (pursuedFunders.size > 0 && unassessed.length >= MIN_CLUSTER) {
    let best: { funder: string; n: number } | null = null;
    for (const key of pursuedFunders) {
      const hits = unassessed.filter((c) => funderKey(c.funder) === key);
      if (hits.length >= MIN_CLUSTER && (best === null || hits.length > best.n)) {
        // The display name comes off a real record rather than the normalised key, so
        // the note says "HRSA" and not "hrsa".
        best = { funder: (hits[0].funder ?? "").trim(), n: hits.length };
      }
    }
    if (best) {
      return {
        body:
          `${best.n} of the ${unassessed.length} unassessed are ${best.funder} programs, ` +
          `the same funder as ${pursuing.length === 1 ? "the one" : "what"} already in pursuit — ` +
          `so the eligibility work is largely done. Worth scoring those first.`,
        action: { label: `Score the ${best.n}`, href: input.triageHref },
      };
    }
  }

  // ── Rule 2: staleness ─────────────────────────────────────────────────────
  // Approved, a deadline inside the window, and no draft started anywhere for this
  // client. The finding is the gap between having committed and having begun.
  if (!input.hasDraft) {
    const stale = cards.filter(
      (c) => c.stage === "approved" && c.deadlineDays !== null && c.deadlineDays >= 0 && c.deadlineDays <= STALE_DEADLINE_DAYS,
    );
    if (stale.length > 0) {
      const soonest = stale.reduce((a, b) => ((a.deadlineDays ?? 0) <= (b.deadlineDays ?? 0) ? a : b));
      const days = soonest.deadlineDays ?? 0;
      return {
        body:
          `${plural(stale.length, "approved grant has", "approved grants have")} a deadline inside ` +
          `${STALE_DEADLINE_DAYS} days and no draft started — the nearest is ${plural(days, "day", "days")} out.`,
        action: { label: "Start the draft", href: input.intellEngineHref },
      };
    }
  }

  return null;
}
