// Refreshes a client's cached USASpending past-performance result. Shared by the
// background intake fetch (client create/edit) and the monthly cron sweep.
//
// Rules (both callers depend on these):
//  - Skip federal_history_verified clients: the human-entered federal_grant_history
//    is authoritative, so we never overwrite it with an API result.
//  - Query usaspending_search_name when set, else the display name (parity with
//    the old live path).
//  - Write ONLY on a verified result (a real answer, including "no awards found").
//    A failed lookup leaves the prior summary intact AND does not advance
//    usaspending_checked_at, so it retries on the next sweep.

import type { SupabaseClient } from "@supabase/supabase-js";
import { checkPastPerformance } from "@/lib/grants/usaspending";

export interface RefreshableClient {
  id: string;
  name: string;
  usaspending_search_name: string | null;
  federal_history_verified: boolean;
}

// Returns true if the cache was written, false if skipped (verified) or the
// lookup failed (left untouched for retry).
export async function refreshClientUSASpending(
  db: SupabaseClient,
  client: RefreshableClient,
): Promise<boolean> {
  if (client.federal_history_verified) return false;

  const result = await checkPastPerformance(client.usaspending_search_name ?? client.name);
  if (!result.verified) return false; // don't overwrite / don't advance checked_at

  const { error } = await db
    .from("clients")
    .update({
      usaspending_summary: result,
      usaspending_checked_at: new Date().toISOString(),
    })
    .eq("id", client.id);
  if (error) {
    console.error("USASpending cache write failed for client", client.id, error.message);
    return false;
  }
  return true;
}

// Convenience for the intake path: load the client's lookup fields by id, then
// refresh. Safe to fire-and-forget via waitUntil.
export async function refreshClientUSASpendingById(
  db: SupabaseClient,
  clientId: string,
): Promise<boolean> {
  const { data } = await db
    .from("clients")
    .select("id, name, usaspending_search_name, federal_history_verified")
    .eq("id", clientId)
    .single<RefreshableClient>();
  if (!data) return false;
  return refreshClientUSASpending(db, data);
}
