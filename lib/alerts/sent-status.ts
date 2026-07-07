import "server-only";
import { createServiceClient } from "@/lib/supabase/server";

// Derive the "Alerted" state for review cards from grant_alerts (PR #67
// persistence) -- no column, no migration. A card is Alerted when it has a
// grant_alerts row that is status='sent' AND has a recorded recipient (sent_to).
// The sent_to guard is deliberate: a row marked sent with no recipient is a data
// problem to surface, NOT to paint as a clean delivery, so it never lights the
// badge. Keying off card_id means a client alert on the same grant (a different
// card) can never light a prospect card's badge.
//
// This module is intentionally light (only the Supabase client) so it can be
// imported by the feed/pages without dragging in the render pipeline from store.ts.

export type SentAlert = { sentAt: string; sentTo: string };

// Latest sent-with-recipient alert per card, batched -- ONE query for many cards,
// no N+1. Returns a Map keyed by card_id (absent = not alerted).
export async function getSentAlertsByCards(cardIds: string[]): Promise<Map<string, SentAlert>> {
  const map = new Map<string, SentAlert>();
  if (cardIds.length === 0) return map;
  const db = createServiceClient();
  const { data } = await db
    .from("grant_alerts")
    .select("card_id, sent_at, sent_to")
    .in("card_id", cardIds)
    .eq("status", "sent")
    .not("sent_to", "is", null)
    .order("sent_at", { ascending: false });
  for (const r of data ?? []) {
    const sentTo = (r.sent_to ?? "").trim();
    if (!sentTo || !r.card_id || !r.sent_at) continue; // guard: no recipient -> not "alerted"
    if (!map.has(r.card_id)) map.set(r.card_id, { sentAt: r.sent_at, sentTo }); // first = latest (desc)
  }
  return map;
}

export async function getSentAlertForCard(cardId: string): Promise<SentAlert | null> {
  return (await getSentAlertsByCards([cardId])).get(cardId) ?? null;
}
