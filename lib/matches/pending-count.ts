import { createClient } from "@/lib/supabase/server";

// The staff review-queue count that backs the Matches badge in the command band.
//
// The definition is deliberately IDENTICAL to the one /matches computes for its own
// worklist (app/(app)/matches/page.tsx): a non-prospect, non-passed review card on an
// account-managed client that has not yet been released to the client
// (sme_released_at IS NULL). The design handoff requires the badge and the pipeline
// card's triage count to be traceable to one query so they can never disagree, so if
// that predicate ever changes, it changes in both places or neither.
//
// Why a count-only query (head: true) rather than reusing the page's grouping: this
// runs in the app-shell layout on every page render, so it must not pull rows. It is
// one indexed count against review_cards with an inner join to clients.
//
// Deliberately NOT cached. A stable-URL SELECT through a cached Supabase client is
// exactly what silently broke the match drain (see CLAUDE.md — the Data Cache served a
// stale empty result for weeks). `createClient` is the request-bound, cookie-scoped
// client and stays uncached; a badge that lies is worse than a badge that costs a query.
export async function pendingReviewCount(): Promise<number | null> {
  try {
    const supabase = createClient();
    const { count, error } = await supabase
      .from("review_cards")
      .select("id, clients!inner(account_managed)", { count: "exact", head: true })
      .eq("clients.account_managed", true)
      .neq("card_type", "prospect")
      .neq("decision", "passed")
      .is("sme_released_at", null);
    if (error) return null;
    return count ?? null;
  } catch {
    // The badge is decoration on a working nav — never let it take the shell down.
    return null;
  }
}
