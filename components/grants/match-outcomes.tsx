import { Badge } from "@/components/ui/badge";
import { CardRematchButton } from "@/components/grants/card-rematch-button";
import type { CardDecision } from "@/types/database";

// Read-only carry-over: which clients matched a grant and the outcome, rendered
// INLINE with no link into /review/[id] (the decision surface Matches owns) --
// linking there would recreate the teleport-into-an-action-surface we're killing.
// Shared by the Ledger detail (who-it-matched record) and the Prospects detail
// ("Also matched" note). Fidelity mirrors the post-decision confirmation screen.
//
// The ONE non-read-only affordance is opt-in: when the caller passes canRematch (the
// Ledger's admin calibration gate, off everywhere else), a still-pending row gets a
// per-card "Re-match" control alongside its badge — the single-card sibling of the
// page's whole-roster re-match. It is NOT a link into the decision surface; it re-scores
// in place. Without the prop the list is byte-identical read-only, so the Prospects
// "Also matched" note is unchanged.
export type OutcomeCard = {
  id: string;
  name: string | null;
  decision: CardDecision;
  sent_at: string | null;
  proposed_role?: string | null;
  recommended_prime?: string | null;
  // Present on the Ledger mapping; drives the re-match gate below (a card a client may
  // already be looking at is not re-scored from here). Optional so other callers omit it.
  sme_released_at?: string | null;
};

// "alerted" ONLY when an approval physically sent (sent_at set); an approval with
// sending off/blocked reads "recorded, not sent" -- never claim an alert went out.
function outcome(c: OutcomeCard): { label: string; variant: "success" | "warning" | "destructive" | "secondary" } {
  if (c.decision === "approved")
    return c.sent_at
      ? { label: "alerted", variant: "success" }
      : { label: "recorded, not sent", variant: "warning" };
  if (c.decision === "passed") return { label: "rejected", variant: "destructive" };
  return { label: "in review", variant: "secondary" }; // pending
}

export function MatchOutcomes({
  cards,
  emptyText,
  canRematch = false,
}: {
  cards: OutcomeCard[];
  emptyText: string;
  // Off by default -> read-only. On (Ledger admin calibration) -> a per-card re-match
  // control on still-pending, not-yet-released rows.
  canRematch?: boolean;
}) {
  if (cards.length === 0) {
    return <p className="text-sm text-muted-foreground">{emptyText}</p>;
  }
  return (
    <ul className="divide-y text-sm">
      {cards.map((c) => {
        const o = outcome(c);
        // Only a pending, un-released row is re-scorable: a decided card is the human's call
        // (the route no-ops on it), and a released one a client may already be viewing.
        const showRematch = canRematch && c.decision === "pending" && !c.sme_released_at;
        return (
          <li key={c.id} className="flex items-center justify-between gap-3 py-3">
            <div className="min-w-0">
              <p className="font-medium">{c.name || "Client"}</p>
              {(c.proposed_role || c.recommended_prime) && (
                <p className="truncate text-xs text-muted-foreground">
                  {c.proposed_role}
                  {c.recommended_prime ? ` · prime: ${c.recommended_prime}` : ""}
                </p>
              )}
            </div>
            <div className="flex shrink-0 items-center gap-3">
              {showRematch && <CardRematchButton cardId={c.id} />}
              <Badge variant={o.variant}>{o.label}</Badge>
            </div>
          </li>
        );
      })}
    </ul>
  );
}
