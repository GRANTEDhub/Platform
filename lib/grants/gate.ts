// Client-first gate.
//
// Goal: never let the prospect engine (Track 2) touch a grant before active
// clients have had first dibs. Status is COMPUTED from the grant's scoring
// status and its CLIENT matches' decisions -- there is no stored flag to drift.
//
//   not_ready -> grant has not finished scoring (status != 'complete'). The
//                prospect engine must NOT pick it up: a client might still match.
//   released  -> scored, and every client match is decided (or there are none).
//                Free to prospect.
//   locked    -> scored, but at least one client match is still pending/hold.
//                Clients have not finished triaging; hold off prospecting.

import { createServiceClient } from "@/lib/supabase/server";
import type { Grant, ReviewCard, CardDecision } from "@/types/database";

// Decisions that count as "decided" for the release rule. Release keys on the
// human's terminal call -- approved (alerted) or passed (rejected) -- NOT on
// sent_at: a failed or blocked send must never deadlock the gate.
//
// These are the STORED enum values. The UI labels ("Alerted" / "Rejected")
// never appear here -- checking a label instead of the stored value yields a
// gate that never releases. That is the trap; the mapping lives only here.
export const DECIDED_DECISIONS: CardDecision[] = ["approved", "passed"];

export function isDecided(decision: CardDecision): boolean {
  return DECIDED_DECISIONS.includes(decision);
}

export type GateStatus = "locked" | "released" | "not_ready";

// Minimal shape the gate needs from a match. Counts CLIENT cards only; prospect
// cards (Track 2) must never enter the lock/release computation.
// A card is a CLIENT card unless it is explicitly marked 'prospect' (migration
// 0019). Keying off card_type !== 'prospect' (rather than === 'client') is
// deliberately migration-order-safe: before the column exists, fetched rows have
// no card_type (undefined) and are correctly treated as client cards; after,
// only prospect cards are excluded. Prospect cards must never enter the gate.
type GateCard = Pick<ReviewCard, "decision"> & { card_type?: string | null };

function isClientCard(c: GateCard): boolean {
  return c.card_type !== "prospect";
}

export function getGrantGateStatus(
  grant: Pick<Grant, "status">,
  cards: GateCard[],
): GateStatus {
  if (grant.status !== "complete") return "not_ready";
  const clientCards = cards.filter(isClientCard);
  if (clientCards.length === 0) return "released"; // scored, no client stake
  return clientCards.every((c) => isDecided(c.decision)) ? "released" : "locked";
}

// Undecided (pending/hold) client matches -- for the read-only status line.
export function undecidedClientCount(cards: GateCard[]): number {
  return cards.filter((c) => isClientCard(c) && !isDecided(c.decision)).length;
}

// Grant ids currently free to prospect: scored AND released. The Track 2
// prospect engine will call this; nothing consumes it yet. Computed each call
// from live card decisions, so a re-match that adds a pending client card
// re-locks the grant automatically with no flag to flip.
export async function releasedGrantsForProspecting(
  db: ReturnType<typeof createServiceClient>,
): Promise<string[]> {
  const { data: grants } = await db
    .from("grants")
    .select("id, status")
    .eq("status", "complete");
  if (!grants || grants.length === 0) return [];

  const ids = grants.map((g) => g.id);
  const { data: cards } = await db
    .from("review_cards")
    .select("grant_id, card_type, decision")
    .in("grant_id", ids);

  const byGrant = new Map<string, GateCard[]>();
  for (const c of cards ?? []) {
    if (!c.grant_id) continue;
    const arr = byGrant.get(c.grant_id) ?? [];
    arr.push({ card_type: c.card_type, decision: c.decision as CardDecision });
    byGrant.set(c.grant_id, arr);
  }

  return grants
    .filter((g) => getGrantGateStatus(g, byGrant.get(g.id) ?? []) === "released")
    .map((g) => g.id);
}
