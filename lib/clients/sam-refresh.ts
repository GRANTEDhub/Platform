import type { SupabaseClient } from "@supabase/supabase-js";
import { searchByNameState, type SamEntity } from "@/lib/sam/client";

// Auto-resolve a client's SAM.gov registration, chained into enrichClient alongside
// the USASpending / IRS-990 / RUCC pulls.
//
// WHY THIS EXISTS: SAM was the only source that required a human to press a button
// before anything happened, which made it look broken next to four rows that filled
// themselves in. The reason it was manual is real -- binding the wrong UEI misreports
// submission readiness -- but that argues for refusing AMBIGUOUS matches, not for
// refusing to look.
//
// So it mirrors the EIN rule: bind automatically only when the answer is unique,
// otherwise leave it for the confirm screen's picker, which shows the candidates.
//   1. Exactly one candidate whose state matches the client's -> bind.
//   2. Exactly one candidate overall -> bind.
//   3. Anything else (several, or none) -> leave unbound for a human.
//
// FILL-IF-EMPTY: a client with a uei already on file is never re-bound here. A human
// confirmed that one, and a name search must not silently replace it.

export interface SamRefreshableClient {
  id: string;
  name?: string | null;
  uei?: string | null;
  location_city?: string | null;
  location_state?: string | null;
}

function pickUnique(candidates: SamEntity[], wantState: string | null): SamEntity | null {
  if (candidates.length === 0) return null;
  if (wantState) {
    const inState = candidates.filter(
      (c) => (c.state ?? "").toUpperCase() === wantState.toUpperCase(),
    );
    if (inState.length === 1) return inState[0];
    // More than one in-state is genuine ambiguity -- do NOT fall through to the
    // "exactly one overall" rule, which would pick an out-of-state org instead.
    if (inState.length > 1) return null;
  }
  return candidates.length === 1 ? candidates[0] : null;
}

// Returns true when a registration was bound. Never throws: SAM can be
// unconfigured (no API key), rate-limited, or simply have no record for the org, and
// none of those should break the enrichment chain or the save that triggered it.
export async function refreshClientSam(
  db: SupabaseClient,
  client: SamRefreshableClient,
): Promise<boolean> {
  if ((client.uei ?? "").trim()) return false; // already confirmed
  const name = (client.name ?? "").trim();
  if (name.length < 3) return false;

  let candidates: SamEntity[];
  try {
    candidates = await searchByNameState(name, client.location_state, client.location_city);
  } catch {
    // Includes the no-API-key config case. Silent: the confirm screen still offers
    // the manual lookup, which surfaces the same error where someone can read it.
    return false;
  }

  const match = pickUnique(candidates, client.location_state ?? null);
  if (!match) return false;

  const { error } = await db
    .from("clients")
    .update({
      uei: match.uei,
      sam_matched_name: match.legalName,
      sam_registration_status: match.status,
      sam_expiration_date: match.expirationDate,
      sam_checked_at: new Date().toISOString(),
    })
    .eq("id", client.id);
  if (error) {
    console.error("SAM auto-bind write failed for client", client.id, error.message);
    return false;
  }
  return true;
}

export async function refreshClientSamById(
  db: SupabaseClient,
  clientId: string,
): Promise<boolean> {
  const { data } = await db
    .from("clients")
    .select("id, name, uei, location_city, location_state")
    .eq("id", clientId)
    .single<SamRefreshableClient>();
  if (!data) return false;
  return refreshClientSam(db, data);
}
