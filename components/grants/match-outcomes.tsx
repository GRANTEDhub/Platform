import { Badge } from "@/components/ui/badge";
import type { CardDecision } from "@/types/database";

// Read-only carry-over: which clients matched a grant and the outcome, rendered
// INLINE with no link into /review/[id] (the decision surface Matches owns) --
// linking there would recreate the teleport-into-an-action-surface we're killing.
// Shared by the Ledger detail (who-it-matched record) and the Prospects detail
// ("Also matched" note). Fidelity mirrors the post-decision confirmation screen.
export type OutcomeCard = {
  id: string;
  name: string | null;
  decision: CardDecision;
  sent_at: string | null;
  proposed_role?: string | null;
  recommended_prime?: string | null;
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

export function MatchOutcomes({ cards, emptyText }: { cards: OutcomeCard[]; emptyText: string }) {
  if (cards.length === 0) {
    return <p className="text-sm text-muted-foreground">{emptyText}</p>;
  }
  return (
    <ul className="divide-y text-sm">
      {cards.map((c) => {
        const o = outcome(c);
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
            <Badge variant={o.variant}>{o.label}</Badge>
          </li>
        );
      })}
    </ul>
  );
}
