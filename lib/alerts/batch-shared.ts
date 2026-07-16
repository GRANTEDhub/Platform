import type { Grant } from "@/types/database";

// Client-SAFE batch constants + ordering (no "server-only", no server imports), so
// the selection UI and the server orchestration sort + cap IDENTICALLY. That's what
// keeps the modal's displayed subject/body/preview order == what send-batch actually
// merges and sends. Server code re-exports these from batch-send.ts.

// Soft cap on a single batch: bounds render cost AND the merged PDF's page count.
// The UI blocks selection above this; the routes reject it defensively.
export const MAX_BATCH_GRANTS = 20;

// Sort key for deadline-ascending order: soonest first, no-deadline / rolling last.
// Uses the parsed ISO `deadline` (null for rolling/undated) -> Infinity sorts last.
export function deadlineSortKey(g: Pick<Grant, "deadline">): number {
  const t = g.deadline ? Date.parse(g.deadline) : NaN;
  return Number.isNaN(t) ? Infinity : t;
}

export function sortByDeadline<T extends { grant: Pick<Grant, "deadline" | "title"> }>(cards: T[]): T[] {
  return cards
    .slice()
    .sort(
      (a, b) =>
        deadlineSortKey(a.grant) - deadlineSortKey(b.grant) ||
        (a.grant.title ?? "").localeCompare(b.grant.title ?? ""),
    );
}
