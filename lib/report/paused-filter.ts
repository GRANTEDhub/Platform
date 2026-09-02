// The staff Review Queue view filter for paused clients (Lever A, migration 0091).
//
// A client with match_active=false is PAUSED: the matcher and the intel QA poller skip it
// going forward, but its EXISTING cards are never deleted — they persist and would still
// pile into the staff Review Queue. This hides those cards from the default staff view,
// reversibly: a "Show paused (N)" toggle brings them back. Nothing here writes or deletes;
// it is a pure read-side filter over already-fetched rows.
//
// Extracted as pure functions so the hide/show/count logic is unit-tested without standing
// up the async server page. The staff page fetches the client's match_active on the joined
// row and calls filterPausedCards.

// A card counts as paused ONLY when its client is explicitly match_active=false. A prospect
// card (null client) is never paused, and a client with match_active true — or a legacy row
// read before the column exists (undefined) — is never paused. So the filter fails toward
// SHOWING a card: only a deliberate false hides it, never a missing/null join.
export function isPausedClientCard(card: {
  clients: { match_active?: boolean | null } | null;
}): boolean {
  return card.clients?.match_active === false;
}

// Split fetched cards into what the staff view renders and how many paused-client cards were
// hidden. `pausedCount` is derived from the FULL set (independent of showPaused), so the
// "Show paused (N)" affordance is accurate whether or not paused cards are currently shown.
export function filterPausedCards<
  T extends { clients: { match_active?: boolean | null } | null },
>(cards: T[], showPaused: boolean): { visible: T[]; pausedCount: number } {
  const pausedCount = cards.reduce((n, c) => (isPausedClientCard(c) ? n + 1 : n), 0);
  const visible = showPaused ? cards : cards.filter((c) => !isPausedClientCard(c));
  return { visible, pausedCount };
}
