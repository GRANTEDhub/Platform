import type { IntellEngineDraftStatus } from "@/types/database";
import { draftCompleteness, type DraftContent, type StepState } from "@/lib/intellengine/content";

// Shared, framework-agnostic helpers for the IntellEngine draft flow (migration
// 0062). Pure functions only -- no DB, no server-only -- so both the server pages
// and the client hub/step components can import them.
//
// STATUS IS A RESUME POINTER, NOT PROGRESS (0074). It records the furthest screen the
// client OPENED, which is a navigation fact and is why clicking Continue advances it.
// It says nothing about whether that step's work was done -- three clicks through empty
// screens used to set it to 'complete' and the hub read that as "Ready to submit".
// Anything that reports progress derives it from the draft's CONTENT instead; see
// lib/intellengine/content.ts and draftProgress below.

// The linear flow. A draft's status is the furthest screen it has reached.
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

// Where a draft was last OPENED. Not a progress claim -- see completenessLabel in
// content.ts for what the hub actually shows. Kept because "you left off at the
// compliance check" is a true and useful thing to say about a resume pointer; it is just
// not the same statement as "the compliance check is done", which is what the old
// "Ready to submit" wording made this column appear to assert.
export const RESUME_LABEL: Record<IntellEngineDraftStatus, string> = {
  scope: "Left off at scope",
  compliance: "Left off at the compliance check",
  build: "Left off in the builder",
  complete: "Walked the whole flow",
};

// How each step reads as a CHECKLIST entry -- the step itself ("Scope" — a rung on the
// ladder, rendered for all of them at once), as distinct from RESUME_LABEL's sentence
// about one draft. 'complete' is absent on purpose: it is not a rung a client does work
// in, it is the conjunction of the others (readyToSubmit), so rendering it as a fourth
// checkbox would double-count the same fact.
export const CHECKLIST_STEPS = ["scope", "compliance", "build"] as const;
export type ChecklistStep = (typeof CHECKLIST_STEPS)[number];

export const STEP_LABEL: Record<ChecklistStep, string> = {
  scope: "Scope",
  compliance: "Compliance",
  build: "Build",
};

export interface DraftStep {
  key: ChecklistStep;
  label: string;
  state: StepState;
}

export interface DraftProgress {
  // Assessable rungs whose content is actually there, over how many CAN be assessed.
  done: number;
  assessable: number;
  percent: number;
  steps: DraftStep[];
  readyToSubmit: boolean;
}

// Progress DERIVED from the draft's CONTENT — nothing stores it, and it is no longer
// derived from status either. Two reasons, in order:
//
//   1. Status is a resume pointer (see above). Reporting it as progress is what let a
//      draft holding nothing display "Ready to submit" at 100%, because walking the
//      three screens is not the same as filling them in.
//   2. A stored progress column would be a second source of truth that can contradict
//      the content, with nothing to reconcile them.
//
// UNASSESSABLE RUNGS ARE EXCLUDED FROM THE DENOMINATOR, not counted as incomplete.
// Compliance cannot be judged until step 4 of the build order, so with scope done and
// build not, this reports 1 of 2 = 50% rather than 1 of 3 = 33% — a draft is not
// penalised for a check the product cannot yet run. Should compliance ever become
// assessable, it joins the denominator automatically.
export function draftProgress(content: DraftContent): DraftProgress {
  const c = draftCompleteness(content);
  const steps: DraftStep[] = CHECKLIST_STEPS.map((key) => ({
    key,
    label: STEP_LABEL[key],
    state: c[key],
  }));
  const assessable = steps.filter((s) => s.state !== "unknown").length;
  const done = steps.filter((s) => s.state === "done").length;
  return {
    done,
    assessable,
    // Guard the divide: if every rung ever became unassessable, 0/0 is NaN and would
    // render as a blank width on the bar.
    percent: assessable === 0 ? 0 : Math.round((done / assessable) * 100),
    steps,
    readyToSubmit: c.readyToSubmit,
  };
}
