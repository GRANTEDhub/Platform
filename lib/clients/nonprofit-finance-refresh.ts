// Refreshes a client's cached IRS 990 financials (ProPublica). Mirrors
// usaspending-refresh.ts and is chained into enrichClient after the USASpending
// step. Rules (parity with the USASpending cache):
//  - Skip when there is no EIN on file (nothing to look up).
//  - Write ONLY on a verified result (a real answer, including "org has no filings
//    with data"). A failed lookup leaves the prior summary intact AND does not
//    advance nonprofit_finance_checked_at, so it retries on the next refresh.

import type { SupabaseClient } from "@supabase/supabase-js";
import { fetchNonprofitFinancials } from "@/lib/grants/propublica";

export interface FinanceRefreshableClient {
  id: string;
  ein: string | null;
}

// Returns true if the cache was written, false if skipped (no EIN) or the lookup
// failed (left untouched for retry).
export async function refreshClientNonprofitFinance(
  db: SupabaseClient,
  client: FinanceRefreshableClient,
): Promise<boolean> {
  if (!client.ein || !client.ein.trim()) return false;

  const result = await fetchNonprofitFinancials(client.ein);
  if (!result.verified) return false; // don't overwrite / don't advance checked_at

  const { error } = await db
    .from("clients")
    .update({
      nonprofit_finance: result,
      nonprofit_finance_checked_at: new Date().toISOString(),
    })
    .eq("id", client.id);
  if (error) {
    console.error("Nonprofit-finance cache write failed for client", client.id, error.message);
    return false;
  }
  return true;
}

// Convenience for the intake path: load the EIN by id, then refresh. Safe to
// fire-and-forget via waitUntil.
export async function refreshClientNonprofitFinanceById(
  db: SupabaseClient,
  clientId: string,
): Promise<boolean> {
  const { data } = await db
    .from("clients")
    .select("id, ein")
    .eq("id", clientId)
    .single<FinanceRefreshableClient>();
  if (!data) return false;
  return refreshClientNonprofitFinance(db, data);
}
