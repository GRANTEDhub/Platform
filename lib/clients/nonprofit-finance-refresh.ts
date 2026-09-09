// Refreshes a client's cached IRS 990 financials (ProPublica). Mirrors
// usaspending-refresh.ts and is chained into enrichClient after the USASpending
// step. Rules (parity with the USASpending cache):
//  - Skip when there is no EIN on file (nothing to look up).
//  - Write ONLY on a verified result (a real answer, including "org has no filings
//    with data"). A failed lookup leaves the prior summary intact AND does not
//    advance nonprofit_finance_checked_at, so it retries on the next refresh.

import type { SupabaseClient } from "@supabase/supabase-js";
import type { NonprofitFinance } from "@/types/database";
import { fetchNonprofitFinancials, resolveEinCandidates } from "@/lib/grants/propublica";

export interface FinanceRefreshableClient {
  id: string;
  ein: string | null;
  name?: string | null;
  org_type?: string | null;
  location_city?: string | null;
  location_state?: string | null;
  // Current annual_budget, so the fill-if-empty seed (annualBudgetFromFinance) never overwrites a value
  // already on file. Supplied by the by-id loader's SELECT below.
  annual_budget?: string | null;
}

// The editable annual_budget default seeded from the 990: total FUNCTIONAL EXPENSES (the operating-budget
// proxy -- deliberately NOT revenue) as a dollar figure tagged with its filing year + source, so a staffer
// sees it is auto-pulled and can override it. Returns null when the 990 has no usable expense figure (a
// verified "no filings" result, or a non-positive value), so the fill never writes a placeholder.
function annualBudgetFromFinance(finance: NonprofitFinance): string | null {
  const exp = finance.total_expenses;
  if (typeof exp !== "number" || !Number.isFinite(exp) || exp <= 0) return null;
  const dollars = `$${Math.round(exp).toLocaleString("en-US")}`;
  const fy = finance.fiscal_year ? `FY${finance.fiscal_year}, ` : "";
  return `${dollars} (${fy}per IRS 990)`;
}

// The value to seed into annual_budget, or null to leave it untouched. FILL-IF-EMPTY first-line guard: a
// value already on file (hand-entered or a prior seed) returns null so no write is even attempted -- but this
// is an in-memory pre-check against a possibly-stale read; the AUTHORITATIVE, race-safe never-overwrite is the
// `.is("annual_budget", null)` condition on the write in refreshClientNonprofitFinance. Otherwise seed from
// the 990's expense figure, or null when it has none. Pure -> unit-tested without a DB (exported for that).
export function budgetFillValue(
  currentBudget: string | null | undefined,
  finance: NonprofitFinance,
): string | null {
  if (currentBudget && currentBudget.trim()) return null; // never overwrite a value on file
  return annualBudgetFromFinance(finance);
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

  // Fill-if-empty: seed annual_budget from the 990's total functional expenses when the client has none on
  // file (the RUCC/SAM convention -- a hand-entered value always wins, and it populates an editable DEFAULT
  // in the same free-text field a staffer edits). Forward-only (runs at intake / enrich, never rewrites an
  // existing card). Unlike nonprofit_finance (citation-only), annual_budget IS read by the scorer as context
  // (never a gate), so a blank-budget client now carries a grounded figure instead of "Unknown".
  //
  // ATOMIC never-overwrite: the ProPublica fetch above can be in flight ~15s, so `client.annual_budget` was
  // read BEFORE it and is stale -- a staffer could have entered a budget meanwhile. budgetFillValue's
  // in-memory guard only skips the common already-set case; the RACE-SAFE guard is the `.is("annual_budget",
  // null)` condition on the write, which Postgres evaluates against the CURRENT row -- so the seed lands ONLY
  // if the column is STILL empty at write time, and a value entered during the fetch is never clobbered.
  // (actions.ts get() normalizes every blank to NULL, so IS NULL covers all blank cases.) Best-effort: a
  // budget-fill failure never fails the finance refresh.
  const budget = budgetFillValue(client.annual_budget, result);
  if (budget) {
    const { error: budgetErr } = await db
      .from("clients")
      .update({ annual_budget: budget })
      .eq("id", client.id)
      .is("annual_budget", null);
    if (budgetErr) {
      console.error("annual_budget 990-prefill write failed for client", client.id, budgetErr.message);
    }
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
    .select("id, ein, name, org_type, location_city, location_state, annual_budget")
    .eq("id", clientId)
    .single<FinanceRefreshableClient>();
  if (!data) return false;
  return refreshClientNonprofitFinance(db, data);
}
