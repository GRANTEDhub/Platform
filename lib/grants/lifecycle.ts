// Grant open/closed lifecycle — DERIVED from the deadline, never stored (the same
// state-model choice as getGrantDisposition). A grant is CLOSED once its parsed
// deadline is strictly in the past, and OPEN otherwise.
//
// Null-safe by design: a null deadline is OPEN, never closed. An indeterminate /
// rolling / unparsed end date must never silently drop a grant from the match pool
// or a report — only a KNOWN past deadline closes a grant. (Mirrors the predicate
// `closed ≡ deadline IS NOT NULL AND deadline < current_date`.)
//
// One reusable classifier rather than an inline filter, because the
// active/forecasted/recurring tier logic will consume this same open/closed concept.
//
// Clock alignment: `deadline` is a DATE column ('YYYY-MM-DD'), and Postgres
// `current_date` resolves in the server's timezone (Supabase = UTC). We compare on
// the UTC calendar date, so a grant due "today" stays OPEN through the whole day
// and the code matches the SQL predicate exactly.

import type { Grant } from "@/types/database";

export type GrantLifecycle = "open" | "closed";

type LifecycleGrant = Pick<Grant, "deadline">;

// `now` is injectable so a batch can classify against one consistent clock (and for
// tests); defaults to the current time.
export function grantLifecycle(grant: LifecycleGrant, now: Date = new Date()): GrantLifecycle {
  const deadline = grant.deadline;
  if (!deadline) return "open"; // null / indeterminate — never dropped
  const today = now.toISOString().slice(0, 10); // 'YYYY-MM-DD' (UTC)
  // Compare calendar date to calendar date. slice() normalizes a stray time
  // component; same-format ISO date strings sort chronologically.
  return deadline.slice(0, 10) < today ? "closed" : "open";
}

export function isGrantOpen(grant: LifecycleGrant, now?: Date): boolean {
  return grantLifecycle(grant, now) === "open";
}

export function isGrantClosed(grant: LifecycleGrant, now?: Date): boolean {
  return grantLifecycle(grant, now) === "closed";
}
