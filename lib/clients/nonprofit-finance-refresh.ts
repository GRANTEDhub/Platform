// Refreshes a client's cached IRS 990 financials (ProPublica). Mirrors
// usaspending-refresh.ts and is chained into enrichClient after the USASpending
// step. Rules (parity with the USASpending cache):
//  - Skip when there is no EIN on file (nothing to look up).
//  - Write ONLY on a verified result (a real answer, including "org has no filings
//    with data"). A failed lookup leaves the prior summary intact AND does not
//    advance nonprofit_finance_checked_at, so it retries on the next refresh.

import type { SupabaseClient } from "@supabase/supabase-js";
import { fetchNonprofitFinancials, resolveEinCandidates } from "@/lib/grants/propublica";

export interface FinanceRefreshableClient {
  id: string;
  ein: string | null;
  name?: string | null;
  org_type?: string | null;
  location_city?: string | null;
  location_state?: string | null;
}

// Resolve and store an EIN when none is on file, so the 990 pull has a key to work
// with -- a nonprofit's own site almost never prints its EIN, which otherwise leaves
// annual budget permanently blank. Nonprofit-only (a city or a business has no 990),
// fill-if-empty, and conservative: only a UNIQUE name+city+state agreement is
// auto-bound, so a null result just leaves the field for a human. Returns the EIN to
// use, if any.
async function ensureEin(
  db: SupabaseClient,
  client: FinanceRefreshableClient,
): Promise<string | null> {
  const existing = (client.ein ?? "").trim();
  if (existing) return existing;
  // Only orgs that actually file a 990. Skipping others avoids a pointless lookup
  // and the risk of matching a similarly-named nonprofit onto a government client.
  const orgType = (client.org_type ?? "").trim();
  if (orgType && orgType !== "nonprofit" && orgType !== "higher_education") return null;
  if (!client.name || !client.name.trim()) return null;

  // Best guess from name + city + state, rather than the older name+state
  // all-or-nothing. autoBind is only ever set for a UNIQUE candidate whose name, city
  // AND state all agree -- so this widens what resolves automatically (a same-named
  // org in another state no longer blocks the real one) WITHOUT widening what gets
  // written on a coin flip. Everything short of that is left for the confirm screen,
  // where a human sees the ranked candidates and the evidence for each.
  const { autoBind } = await resolveEinCandidates({
    name: client.name,
    city: client.location_city ?? null,
    state: client.location_state ?? null,
  });
  if (!autoBind) return null;
  const { error } = await db.from("clients").update({ ein: autoBind.ein }).eq("id", client.id);
  if (error) {
    console.error("EIN auto-resolve write failed for client", client.id, error.message);
    return null;
  }
  return autoBind.ein;
}

// Returns true if the cache was written, false if skipped (no EIN) or the lookup
// failed (left untouched for retry).
export async function refreshClientNonprofitFinance(
  db: SupabaseClient,
  client: FinanceRefreshableClient,
): Promise<boolean> {
  // Auto-resolve the EIN when it is missing, so the budget pull is not gated on
  // someone hand-entering one. No EIN resolvable -> nothing to look up.
  const ein = await ensureEin(db, client);
  if (!ein) return false;

  const result = await fetchNonprofitFinancials(ein);
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
    .select("id, ein, name, org_type, location_city, location_state")
    .eq("id", clientId)
    .single<FinanceRefreshableClient>();
  if (!data) return false;
  return refreshClientNonprofitFinance(db, data);
}
