import type { SupabaseClient } from "@supabase/supabase-js";
import { refreshClientUSASpendingById } from "@/lib/grants/usaspending-refresh";
import { refreshClientProfileById } from "@/lib/clients/profile";

// Out-of-band client enrichment, fire-and-forget via waitUntil on the same events
// USASpending already fetched on (public intake, admin client create/edit).
//
// Order matters: USASpending FIRST, then the client-profile refine, so the refine
// reads the freshly-cached usaspending_summary as its federal-history CROSS-CHECK
// rather than racing it (self-report stays authoritative; USASpending is only a
// supplement). Chaining costs nothing user-facing -- it all runs after the
// response / redirect.
//
// Each step is independently guarded: one failing never blocks the other, and
// this never throws into the caller's waitUntil. A failed profile refine leaves
// client_profile null (Stage-1 null-safe fallback); the next edit or the Stage-3
// backfill re-attempts it.
export async function enrichClient(db: SupabaseClient, clientId: string): Promise<void> {
  try {
    await refreshClientUSASpendingById(db, clientId);
  } catch (err) {
    console.error(
      "enrichClient: USASpending refresh failed for client",
      clientId,
      err instanceof Error ? err.message : err,
    );
  }
  // refreshClientProfileById already catches internally; this is belt-and-suspenders.
  try {
    await refreshClientProfileById(db, clientId);
  } catch (err) {
    console.error(
      "enrichClient: profile refresh failed for client",
      clientId,
      err instanceof Error ? err.message : err,
    );
  }
}
