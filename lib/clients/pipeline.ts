import type { CardDecision } from "@/types/database";

// The grant pipeline for one client — the funnel a match actually travels.
//
// FOUR live stages, not five. The design called for a fifth, "Submitted", and there
// is nothing in the schema that records it: no submitted_at, no submission status,
// and `decision` is only pending / approved / passed. A fifth segment would therefore
// read 0 for every client forever while implying we track submissions, so it is left
// out until a migration gives it something real to count. Adding it later is one
// entry in STAGES plus one branch in stageOf.
//
// PASSED IS NOT A SEGMENT either, by decision: it is the largest bucket by far for
// any established client, so as a proportional bar segment it would swallow the four
// stages that actually need attention. It is reported as a caption count instead.
//
// EVERY COUNT IS DERIVED FROM ONE CASCADE (stageOf), so the segments partition the
// card set by construction — the parts cannot fail to sum to the whole, and no card
// can be double-counted into two stages. That property is why this is a pure function
// over rows rather than four independent filters that could drift apart.

export type PipelineStageKey = "review" | "alert" | "interested" | "pursuit";

// The columns this needs. Deliberately narrow: it is a projection of review_cards,
// so the page's existing query only has to add `sent_at` to what it already selects.
export interface PipelineCard {
  decision: CardDecision;
  interested_at: string | null;
  // Released to the client's portal (written by /api/review/[id] and its
  // release-email sibling).
  sme_released_at: string | null;
  // The alert email physically went out (written by lib/alerts/send-core).
  sent_at: string | null;
}

export interface PipelineStage {
  key: PipelineStageKey;
  label: string;
  count: number;
  // True when the stage is waiting on GRANTED rather than on the client. Drives the
  // count colour: an actionable stage is coloured, everything else stays ink.
  needsAction: boolean;
}

// NO per-stage links, deliberately. The design has each column click through to a
// pre-filtered list, and there is nowhere for it to go: /matches takes no
// searchParams (it is a cross-client review worklist, not a filterable per-client
// list) and the roadmap list has no stage filter either. A link carrying ?stage=
// would be silently ignored and land you on an unfiltered page that looks like the
// answer — worse than a column that plainly isn't clickable. Adding `?stage=` support
// to the roadmap list is a small follow-up that makes all four columns real links.

const STAGES: { key: PipelineStageKey; label: string; needsAction: boolean }[] = [
  // Matched, nothing has gone out. Ours to act on.
  { key: "review", label: "GRANTED Review", needsAction: true },
  // The alert went out; the client hasn't responded. Theirs.
  { key: "alert", label: "Grant Alert", needsAction: false },
  // They said it's worth a closer look, but haven't committed.
  { key: "interested", label: "Interested", needsAction: false },
  // decision='approved' — being pursued, in-house or in-platform (pursuit_path).
  { key: "pursuit", label: "In Pursuit", needsAction: false },
];

// An alert has reached the client when either marker is set. Both exist because they
// record different acts: sme_released_at unlocks the portal view, sent_at means an
// email physically left. Either one means the client can see it, so either one moves
// the card out of GRANTED Review — treating only one as authoritative would park
// released-but-not-emailed cards in our queue forever.
function alerted(c: PipelineCard) {
  return c.sent_at !== null || c.sme_released_at !== null;
}

// ONE cascade, first match wins. Order is the funnel read backwards, so a card that
// has advanced is never reported at an earlier stage: a card approved without ever
// being alerted (staff pursuing directly) is In Pursuit, not GRANTED Review.
export function stageOf(c: PipelineCard): PipelineStageKey | "passed" {
  if (c.decision === "passed") return "passed";
  if (c.decision === "approved") return "pursuit";
  if (c.interested_at !== null) return "interested";
  if (alerted(c)) return "alert";
  return "review";
}

export interface Pipeline {
  stages: PipelineStage[];
  // Everything not passed — what the bar is proportioned over.
  tracked: number;
  passed: number;
}

export function derivePipeline(cards: PipelineCard[]): Pipeline {
  const counts = new Map<PipelineStageKey | "passed", number>();
  for (const c of cards) {
    const k = stageOf(c);
    counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  const stages = STAGES.map((s) => ({ ...s, count: counts.get(s.key) ?? 0 }));
  return {
    stages,
    tracked: stages.reduce((n, s) => n + s.count, 0),
    passed: counts.get("passed") ?? 0,
  };
}
