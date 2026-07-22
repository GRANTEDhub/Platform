import Link from "next/link";
import { format, parseISO } from "date-fns";
import { Check, Archive } from "lucide-react";
import { Card } from "@/components/ui/card";
import { SectionTitle } from "./primitives";

// Closes the decision loop for the account manager: what the CLIENT decided on
// the shared surface (decided_by_actor = 'client'). Interested = the client's
// Pursue; Passed carries the why-not (the same reason that feeds match_feedback
// calibration). Includes client passes — which the roadmap list itself hides — so
// the AM sees the full picture of client input. Staff-only surface.

export interface ClientActivityItem {
  cardId: string;
  title: string;
  decision: "approved" | "passed";
  reason: string | null;
  decidedAt: string | null;
}

function shortDate(iso: string | null): string | null {
  if (!iso) return null;
  try {
    return format(parseISO(iso), "MMM d");
  } catch {
    return null;
  }
}

export function ClientActivity({
  items,
  basePath,
  clientName,
}: {
  items: ClientActivityItem[];
  basePath: string; // card detail = `${basePath}/${cardId}`
  clientName: string;
}) {
  if (items.length === 0) return null;
  return (
    <Card className="mb-5 p-6 sm:p-7">
      <div className="flex items-center justify-between gap-3">
        <SectionTitle>What {clientName} decided</SectionTitle>
        <span className="shrink-0 rounded-full bg-brand-orange/10 px-3 py-1 text-xs font-semibold text-brand-orange">
          {items.length} client {items.length === 1 ? "pick" : "picks"}
        </span>
      </div>
      <ul className="mt-4 space-y-3">
        {items.map((it) => {
          const interested = it.decision === "approved";
          const d = shortDate(it.decidedAt);
          return (
            <li key={it.cardId} className="flex gap-3">
              <span
                className={`mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full ${
                  interested ? "bg-brand-navy/[0.06] text-brand-navy" : "bg-destructive/10 text-destructive"
                }`}
              >
                {interested ? <Check className="h-3.5 w-3.5" strokeWidth={3} /> : <Archive className="h-3.5 w-3.5" />}
              </span>
              <div className="min-w-0 flex-1">
                <p className="text-sm text-foreground">
                  {interested ? "Interested in " : "Passed on "}
                  <Link href={`${basePath}/${it.cardId}`} className="font-semibold text-brand-navy hover:underline">
                    {it.title}
                  </Link>
                  {d && <span className="text-muted-foreground"> · {d}</span>}
                </p>
                {!interested && it.reason && (
                  <p className="mt-0.5 text-[13px] italic text-muted-foreground">&ldquo;{it.reason}&rdquo;</p>
                )}
              </div>
            </li>
          );
        })}
      </ul>
    </Card>
  );
}
