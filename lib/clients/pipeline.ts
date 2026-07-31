import type { CardDecision, PursuitPath } from "@/types/database";

// The grant pipeline for one client — the funnel a match actually travels.
//
// FIVE stages, matching the approved design (design/dashboard/). An earlier pass built
// four and reported Passed as a caption count; both of those decisions are revisited
// here, and the reasoning for each is worth keeping because the earlier reasoning was
// sound about a DIFFERENT question:
//
//   · The fifth stage the earlier pass declined to build was "Submitted", which the
//     design does not actually contain and the schema cannot support (no submitted_at,
//     no submission status). Declining it was right. The design's fifth column is
//     "Passed", which is fully backed by decision='passed'.
//   · Passed was kept out of the bar because it is the largest bucket for an
//     established client and would swallow the stages that need attention. The design
//     accepts that trade deliberately: it is a semantic funnel read left to right,
//     ending in terminal taupe, and a five-slot bar whose last slot is large still
//     reads correctly because the colour scale says "this is the end", not "this is
//     important". Terminal stages are muted in the count row for the same reason.
//
// APPROVED AND IN PURSUIT ARE GENUINELY DISTINCT, verified against the write path
// rather than the column comment. types/database.ts says pursuit_path is "set alongside
// decision='approved'", but app/api/review/[id]/route.ts:168 leaves it `undefined` when
// recording an approval -- it is not written there. The path is chosen in a separate
// act, and app/intellengine/page.tsx filters on exactly `decision !== 'passed' &&
// pursuit_path === null` to find cards awaiting that choice. So:
//   Approved    decided, path not yet chosen  (a real, populated state)
//   In pursuit  path chosen, work under way
// Had approval written the path, "Approved" would have been a permanently-zero column,
// which is the trap the "Submitted" stage was rejected for.
//
// EVERY COUNT IS DERIVED FROM ONE CASCADE (stageOf), so the segments partition the
// card set by construction — the parts cannot fail to sum to the whole, and no card
// can be double-counted into two stages. That property is why this is a pure function
// over rows rather than five independent filters that could drift apart.

export type PipelineStageKey = "triage" | "client" | "approved" | "pursuit" | "passed";

// The columns this needs. Deliberately narrow: it is a projection of review_cards.
export interface PipelineCard {
  decision: CardDecision;
  interested_at: string | null;
  // Released to the client's portal (written by /api/review/[id] and its
  // release-email sibling).
  sme_released_at: string | null;
  // The alert email physically went out (written by lib/alerts/send-core).
  sent_at: string | null;
  // How the client chose to pursue. Null on an approved card means the decision is
  // recorded but the path is still open — that is the Approved stage.
  pursuit_path: PursuitPath | null;
}

export interface PipelineStage {
  key: PipelineStageKey;
  label: string;
  count: number;
  // True when the stage is waiting on GRANTED rather than on the client. Drives the
  // count colour: an actionable stage is coloured.
  needsAction: boolean;
  // End of the funnel. A terminal count is muted however large it gets — there is
  // nothing to act on, so it must not pull the eye the way triage does.
  terminal: boolean;
}

// NO per-stage links yet. The design has each column click through to a pre-filtered
// list and there is nowhere for it to go: /matches takes no searchParams (it is a
// cross-client review worklist, not a filterable per-client list) and the roadmap list
// has no stage filter either. A link carrying ?stage= would be silently ignored and
// land you on an unfiltered page that looks like the answer — worse than a column that
// plainly isn't clickable. The columns therefore also drop the hover/cursor affordance,
// so they do not advertise themselves as links. Tracked as a follow-up.

const STAGES: { key: PipelineStageKey; label: string; needsAction: boolean; terminal: boolean }[] = [
  // Matched, nothing has gone out and nobody has triaged it. Ours to act on.
  { key: "triage", label: "Needs triage", needsAction: true, terminal: false },
  // It has reached them — alerted, or flagged interesting — and no decision yet. Theirs.
  { key: "client", label: "With client", needsAction: false, terminal: false },
  // decision='approved', pursuit_path still null: committed, path not chosen.
  { key: "approved", label: "Approved", needsAction: false, terminal: false },
  // pursuit_path set — routed in-house or to IntellEngine.
  { key: "pursuit", label: "In pursuit", needsAction: false, terminal: false },
  // decision='passed'.
  { key: "passed", label: "Passed", needsAction: false, terminal: true },
];

// An alert has reached the client when either marker is set. Both exist because they
// record different acts: sme_released_at unlocks the portal view, sent_at means an
// email physically left. Either one means the client can see it, so either one moves
// the card out of triage — treating only one as authoritative would park
// released-but-not-emailed cards in our queue forever.
function alerted(c: PipelineCard) {
  return c.sent_at !== null || c.sme_released_at !== null;
}

// ONE cascade, first match wins. Order is the funnel read backwards, so a card that
// has advanced is never reported at an earlier stage: a card approved without ever
// being alerted (staff pursuing directly) is Approved, not Needs triage.
export function stageOf(c: PipelineCard): PipelineStageKey {
  if (c.decision === "passed") return "passed";
  if (c.decision === "approved") return c.pursuit_path !== null ? "pursuit" : "approved";
  // interested_at is a "worth a closer look" signal, NOT a commitment (see
  // types/database.ts) — so it does not imply approval, but it does mean the card is
  // no longer ours to triage. Both it and an alert land here.
  if (alerted(c) || c.interested_at !== null) return "client";
  return "triage";
}

export interface Pipeline {
  stages: PipelineStage[];
  // Every card, INCLUDING passed — the design's header reads "{n} opportunities
  // tracked" against the sum of all five columns, so a client with 16 to triage and 3
  // passed is tracking 19, not 16.
  total: number;
}

export function derivePipeline(cards: PipelineCard[]): Pipeline {
  const counts = new Map<PipelineStageKey, number>();
  for (const c of cards) {
    const k = stageOf(c);
    counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  const stages = STAGES.map((s) => ({ ...s, count: counts.get(s.key) ?? 0 }));
  return { stages, total: stages.reduce((n, s) => n + s.count, 0) };
}
