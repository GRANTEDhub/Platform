import Link from "next/link";
import { ScoreBadge, DecisionBadge } from "@/components/grants/badges";
import type { MatchCard } from "@/lib/grants/grouping";

// A single match rendered as a table row. Shared by the cross-client matching
// queue (surface 2) and the per-client grant-activity view (surface 3) so both
// render matches identically from one place. Expects a <table> ancestor with
// columns: Opportunity / Fit / Status / Deadline.
export function MatchRow({ card }: { card: MatchCard }) {
  return (
    <tr className="border-b last:border-0 hover:bg-muted/30">
      <td className="px-4 py-3">
        <Link href={`/review/${card.id}`} className="font-medium hover:underline">
          {card.grants?.title || "Untitled opportunity"}
        </Link>
        <p className="text-xs text-muted-foreground">
          {card.grants?.funder}
          {card.proposed_role ? ` · ${card.proposed_role}` : ""}
        </p>
      </td>
      <td className="px-4 py-3"><ScoreBadge score={card.fit_score} /></td>
      <td className="px-4 py-3"><DecisionBadge decision={card.decision} /></td>
      <td className="px-4 py-3 text-right text-xs text-muted-foreground">
        {card.grants?.submission_deadline || "—"}
      </td>
    </tr>
  );
}
