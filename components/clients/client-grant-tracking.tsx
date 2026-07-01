import Link from "next/link";
import { Badge } from "@/components/ui/badge";

// Grants we've committed to a client (approved in Matches). One row per alerted
// grant. v2 will add a pursuit_stage per row (awaiting -> in pursuit -> submitted
// -> won/lost) plus the terminal-drops-to-Ledger filter; because this already
// renders one row per grant with a status slot, that control slots in here with
// no restructuring.
export type TrackedGrant = {
  cardId: string;
  grantId: string | null;
  title: string | null;
  funder: string | null;
  deadline: string | null;
  sentAt: string | null;
};

export function ClientGrantTracking({ grants }: { grants: TrackedGrant[] }) {
  if (grants.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        No grants alerted to this client yet — approving a match in Matches lands it here.
        (Grants from before go-live populate once the retroactive onboarding sweep is built.)
      </p>
    );
  }
  return (
    <ul className="divide-y text-sm">
      {grants.map((g) => (
        <li key={g.cardId} className="flex items-start justify-between gap-3 py-3">
          <div className="min-w-0">
            {g.grantId ? (
              // Links to the grant's read-only Ledger record, not the decision
              // surface -- this is a report of what we committed, not an action.
              <Link href={`/grants/${g.grantId}`} className="font-medium hover:underline">
                {g.title || "Untitled opportunity"}
              </Link>
            ) : (
              <span className="font-medium">{g.title || "Untitled opportunity"}</span>
            )}
            <p className="truncate text-xs text-muted-foreground">
              {[g.funder, g.deadline ? `deadline ${g.deadline}` : null].filter(Boolean).join(" · ")}
            </p>
          </div>
          {/* Honest outcome: "alerted" ONLY when the email actually sent. */}
          <Badge variant={g.sentAt ? "success" : "warning"}>
            {g.sentAt ? "alerted" : "recorded (not sent)"}
          </Badge>
        </li>
      ))}
    </ul>
  );
}
