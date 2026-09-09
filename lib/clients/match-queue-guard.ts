// Cheap "is there anything to drain?" check for the client one-time-match queue.
//
// drainClientMatchQueue (lib/clients/match-queue.ts, PROTECTED) loads the WHOLE grant
// pool up front -- a select("*") over every profiled grant, ~2.4s and pulling raw_text
// -- BEFORE it looks for a claimable client. So an empty queue still pays that scan on
// every invocation. The client-match cron fires every 10 min all day and the queue is
// empty on almost every tick, which made that pool load the platform's single biggest
// wasted recurring query (~140 of 144 daily runs scanning the corpus to find nothing,
// a repeated heavy-IO burst on an IO-constrained instance).
//
// This lets a ROUTE skip the drain entirely when nothing is queued, WITHOUT touching
// the protected drain: the fix lives at the call site, not in the matcher.
//
// Predicate = the drain's own status gate (queued|running) MINUS the lease filter. We
// only fast-skip when there is NOTHING queued or running at all; a queued/running
// client (even one another live drain holds a fresh lease on) still falls through to
// the drain, which keeps its full lease-aware behaviour. So a real enqueue is NEVER
// skipped -- zero added latency, this only ever removes the no-op tick.

import type { createServiceClient } from "@/lib/supabase/server";

type DB = ReturnType<typeof createServiceClient>;

export async function anyClientMatchPending(db: DB): Promise<boolean> {
  const { count, error } = await db
    .from("clients")
    .select("id", { count: "exact", head: true })
    .in("initial_match_status", ["queued", "running"]);
  // FAIL OPEN: on a query error do NOT skip -- fall through to the drain so a transient
  // read blip can never silently pause client matching (the 2026-07-21 silent-stall
  // shape). A wasted pool load on an error tick is the safe direction.
  if (error) return true;
  return (count ?? 0) > 0;
}
