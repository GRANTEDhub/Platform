// Auto-derives a client's RUCC (rurality) from their county via the USDA ERS 2023
// crosswalk and stores it into clients.rucc_codes. Chained into enrichClient BEFORE
// the profile refine so the distillation reads the derived value.
//
// FILL-IF-EMPTY ONLY: never overwrites a manually-entered rucc_codes — a hand-typed
// value always wins. No migration (rucc_codes already exists). ENRICHMENT/CITATION
// only: post-#241 the matcher treats RUCC as a flag, never a gate, so this can't hide
// a grant. No network call — it's a local table lookup, so it always resolves or no-ops.

import type { SupabaseClient } from "@supabase/supabase-js";
import { ruccForCountyState, formatRuccForStorage } from "@/lib/geo/rucc";

export interface RuccRefreshableClient {
  id: string;
  rucc_codes: string | null;
  location_state: string | null;
  location_county: string | null;
}

// Returns true if rucc_codes was written, false if skipped (already set, missing
// county/state, or county didn't resolve).
export async function refreshClientRucc(
  db: SupabaseClient,
  client: RuccRefreshableClient,
): Promise<boolean> {
  // A manually-entered value always wins — never clobber it.
  if (client.rucc_codes && client.rucc_codes.trim()) return false;

  const hit = ruccForCountyState(client.location_state, client.location_county);
  if (!hit) return false;

  const { error } = await db
    .from("clients")
    .update({ rucc_codes: formatRuccForStorage(client.location_county ?? "", hit) })
    .eq("id", client.id);
  if (error) {
    console.error("RUCC auto-fill write failed for client", client.id, error.message);
    return false;
  }
  return true;
}

export async function refreshClientRuccById(
  db: SupabaseClient,
  clientId: string,
): Promise<boolean> {
  const { data } = await db
    .from("clients")
    .select("id, rucc_codes, location_state, location_county")
    .eq("id", clientId)
    .single<RuccRefreshableClient>();
  if (!data) return false;
  return refreshClientRucc(db, data);
}
