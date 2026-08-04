import type { SupabaseClient } from "@supabase/supabase-js";
import type { ReadSide } from "@/lib/report/shape";

// Per-side read state for a Grant Report row (migration 0070). The console and the
// portal each own one column and neither can see the other's; see the migration for why
// that is two columns rather than one tagged column, and where Postgres enforces it.
const COLUMN: Record<ReadSide, "staff_read_at" | "client_read_at"> = {
  staff: "staff_read_at",
  client: "client_read_at",
};

// Stamp "this side has now read this card", opening the card being the read.
//
// FIRST READ WINS. The `.is(col, null)` filter is what makes that true, and it does two
// jobs: the stored timestamp keeps meaning "first read" rather than "last opened", and
// the write becomes idempotent — which matters because this is called from a server
// component's render path, and a re-render (or React strict-mode double invocation in
// dev) must not rewrite the value. It also means an explicit mark-as-unread genuinely
// restores the unread state instead of being immediately re-stamped by a stale render.
//
// FAILURE IS SILENT, BY DESIGN. A read stamp is bookkeeping; it must never be the reason
// a grant page 500s. The caller renders regardless, and the row simply stays unread — the
// honest outcome, and self-correcting on the next visit. `supabase` must be the
// USER-scoped client: the client-side write is authorised by the 0070 guard branch, which
// reads auth.uid() and would refuse a service-role caller.
export async function markCardRead(
  supabase: SupabaseClient,
  cardId: string,
  side: ReadSide,
): Promise<void> {
  const col = COLUMN[side];
  try {
    await supabase
      .from("review_cards")
      .update({ [col]: new Date().toISOString() })
      .eq("id", cardId)
      .is(col, null);
  } catch {
    // Swallowed on purpose — see above.
  }
}

// Clear read state so the row returns to unread/white. Staff-driven: the explicit
// mark-as-unread control and its bulk action (both console-only), plus recall, which
// rewinds a card to pre-send and so must not leave either side looking read.
export async function markCardsUnread(
  supabase: SupabaseClient,
  cardIds: string[],
  sides: ReadSide[],
): Promise<{ error: string | null }> {
  if (cardIds.length === 0 || sides.length === 0) return { error: null };
  const patch: Record<string, null> = {};
  for (const s of sides) patch[COLUMN[s]] = null;
  const { error } = await supabase.from("review_cards").update(patch).in("id", cardIds);
  return { error: error ? error.message : null };
}
