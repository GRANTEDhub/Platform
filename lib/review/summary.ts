import "server-only";
import type { createClient } from "@/lib/supabase/server";

// Post-decision summary for the Matches confirmation screen (DecisionConfirmation).
// Shared by the two terminal-decision paths: the plain-text outreach approve
// (PATCH /api/review) and the grant-alert send (POST /api/alerts/[cardId]/send),
// so both surface the identical "grant complete / N remaining / prospect-eligible"
// outcome. Computed only for a terminal decision on a CLIENT card (prospect cards
// keep the inline flow). Call AFTER the send/stamp block so the just-decided
// card's sent_at is fresh.

export type DecidedResult = {
  name: string | null;
  decision: "approved" | "passed";
  sent: boolean;
};

export type GrantSummary = {
  grant_id: string;
  completed: boolean;
  prospect_eligible: boolean;
  remaining_pending: string[];
  decided_results: DecidedResult[];
};

// Supabase types a to-one embed as an array; normalize both shapes.
type SiblingCard = {
  decision: string;
  sent_at: string | null;
  card_type: string | null;
  clients: { name: string } | { name: string }[] | null;
};

function siblingName(c: SiblingCard): string | null {
  const cl = c.clients;
  if (!cl) return null;
  return Array.isArray(cl) ? cl[0]?.name ?? null : cl.name;
}

//   completed         -> zero remaining pending client cards on this grant
//   prospect_eligible -> completed AND the grant would actually reach the prospect
//                        feed (mirrors getProspectFeed's predicate) -- so the
//                        "available for prospecting" line shows only when true.
//   decided_results   -> per decided client: alerted (approved AND email sent,
//                        i.e. sent_at set) vs recorded-not-sent vs rejected.
export async function computeGrantSummary(
  supabase: ReturnType<typeof createClient>,
  card: { card_type: string | null; grant_id: string | null },
): Promise<GrantSummary | null> {
  if (card.card_type === "prospect" || !card.grant_id) return null;

  const { data: siblings } = await supabase
    .from("review_cards")
    .select("decision, sent_at, card_type, clients(name)")
    .eq("grant_id", card.grant_id);
  const clientCards = ((siblings ?? []) as SiblingCard[]).filter((c) => c.card_type !== "prospect");
  const remaining = clientCards.filter((c) => c.decision === "pending");
  const completed = remaining.length === 0;

  let prospect_eligible = false;
  if (completed) {
    const { data: g } = await supabase
      .from("grants")
      .select("is_domestic, skip_reason, hard_disqualifiers, grant_status")
      .eq("id", card.grant_id)
      .single();
    prospect_eligible =
      !!g &&
      g.is_domestic === true &&
      !g.skip_reason &&
      (g.hard_disqualifiers?.length ?? 0) === 0 &&
      g.grant_status !== "Forecasted";
  }

  return {
    grant_id: card.grant_id,
    completed,
    prospect_eligible,
    remaining_pending: remaining.map((c) => siblingName(c)).filter((n): n is string => !!n),
    decided_results: clientCards
      .filter((c) => c.decision !== "pending")
      .map((c) => ({
        name: siblingName(c),
        decision: c.decision as "approved" | "passed",
        sent: !!c.sent_at,
      })),
  };
}
