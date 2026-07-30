import type { SupabaseClient } from "@supabase/supabase-js";
import { refreshClientUSASpendingById } from "@/lib/grants/usaspending-refresh";
import { refreshClientNonprofitFinanceById } from "@/lib/clients/nonprofit-finance-refresh";
import { refreshClientSamById } from "@/lib/clients/sam-refresh";
import { refreshClientRuccById } from "@/lib/clients/rucc-refresh";
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
  // IRS 990 financials (ProPublica), keyed on the EIN. Independently guarded and a
  // no-op when no EIN is on file. Runs before the profile refine so the distillation
  // can read the freshly-cached figure as a budget citation.
  try {
    await refreshClientNonprofitFinanceById(db, clientId);
  } catch (err) {
    console.error(
      "enrichClient: nonprofit-finance refresh failed for client",
      clientId,
      err instanceof Error ? err.message : err,
    );
  }
  // SAM.gov registration, auto-bound only on an unambiguous name+state match. Was
  // the one source that needed a button pressed before anything happened, which read
  // as broken next to four rows that filled themselves in. Independently guarded and
  // fill-if-empty, so a human-confirmed UEI is never replaced by a name search.
  try {
    await refreshClientSamById(db, clientId);
  } catch (err) {
    console.error(
      "enrichClient: SAM auto-bind failed for client",
      clientId,
      err instanceof Error ? err.message : err,
    );
  }
  // Auto-derive RUCC (rurality) from the client's county via the USDA ERS crosswalk
  // (local lookup, no network). Fill-if-empty, so a manual value is never clobbered.
  // Runs before the profile refine so the distillation reads the derived value.
  try {
    await refreshClientRuccById(db, clientId);
  } catch (err) {
    console.error(
      "enrichClient: RUCC auto-fill failed for client",
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
