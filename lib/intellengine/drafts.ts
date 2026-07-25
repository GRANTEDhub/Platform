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
