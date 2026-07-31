import type { IntellEngineDraftStatus } from "@/types/database";

// Shared, framework-agnostic helpers for the IntellEngine draft flow (migration
// 0062). Pure functions only -- no DB, no server-only -- so both the server pages
// and the client hub/step components can import them.

// The linear flow. A draft's status is the furthest of these it has reached.
export const STEP_ORDER: IntellEngineDraftStatus[] = ["scope", "compliance", "build", "complete"];

// Never regress: given the stored status and a step the client just advanced to,
// keep whichever is further along. Guards against re-opening an earlier step (via
// the hub's resume link or the browser back button) knocking the status backward.
export function furthestStatus(
  current: IntellEngineDraftStatus,
  next: IntellEngineDraftStatus,
): IntellEngineDraftStatus {
  return STEP_ORDER.indexOf(next) > STEP_ORDER.indexOf(current) ? next : current;
}

// Which flow route the per-draft landing sends the client to. 'complete' resumes
// at the builder (the last editable step) rather than a dead end.
export function resumeStep(status: IntellEngineDraftStatus): "scope" | "compliance" | "build" {
  if (status === "compliance") return "compliance";
  if (status === "build" || status === "complete") return "build";
  return "scope";
}

// How a draft's status reads in the hub list.
export const STATUS_LABEL: Record<IntellEngineDraftStatus, string> = {
  scope: "Scoping",
  compliance: "Compliance check",
  build: "Drafting",
  complete: "Ready to submit",
};

// How each step reads as a CHECKLIST entry. Deliberately separate from
// STATUS_LABEL: that one is progressive ("Scoping" — what is happening right now,
// for the one status a draft currently holds), this one names the step itself
// ("Scope" — a rung on the ladder, rendered for all four at once). Same ladder,
// two grammatical jobs; collapsing them would make one of the two read wrong.
export const STEP_LABEL: Record<IntellEngineDraftStatus, string> = {
  scope: "Scope",
  compliance: "Compliance",
  build: "Build",
  complete: "Complete",
};

export interface DraftStep {
  key: IntellEngineDraftStatus;
  label: string;
  done: boolean;
}

export interface DraftProgress {
  step: number; // 1-based rung the draft currently sits on
  total: number;
  percent: number; // step/total — 25 / 50 / 75 / 100
  steps: DraftStep[];
}

// Structural progress DERIVED from status — there is no stored progress column, on
// purpose. STEP_ORDER already encodes how far a draft has got, so a separate
// percentage field would be a second source of truth that can contradict it (status
// 'build' while progress says 10%) with nothing to reconcile them. Everything the
// dashboard's draft card shows — the bar, the percentage, the checklist — comes from
// this one function, so they cannot disagree with the hub's own status label either.
//
// It reports STRUCTURAL progress (which step), not content completeness: 'build' at
// 75% means the draft reached the builder, not that three quarters of the narrative
// is written. The card labels it as such.
export function draftProgress(status: IntellEngineDraftStatus): DraftProgress {
  // indexOf is -1 for a status outside the ladder (only reachable if the DB check
  // constraint is ever widened without updating STEP_ORDER); clamping to 0 degrades
  // to "first step" rather than rendering a negative percentage.
  const idx = Math.max(0, STEP_ORDER.indexOf(status));
  const total = STEP_ORDER.length;
  return {
    step: idx + 1,
    total,
    percent: Math.round(((idx + 1) / total) * 100),
    steps: STEP_ORDER.map((key, i) => ({ key, label: STEP_LABEL[key], done: i <= idx })),
  };
}
