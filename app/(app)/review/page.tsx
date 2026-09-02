import Link from "next/link";
import { requireUser } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { PageHeader } from "@/components/layout/page-header";
import { ScoreBadge, DecisionBadge } from "@/components/grants/badges";
import { filterPausedCards, isPausedClientCard } from "@/lib/report/paused-filter";
import type { ReviewCard, Client, Grant } from "@/types/database";

export const dynamic = "force-dynamic";

const FILTERS = [
  { value: "all", label: "All" },
  { value: "pending", label: "Pending" },
  { value: "approved", label: "Approved" },
  { value: "passed", label: "Passed" },
];

type Row = ReviewCard & {
  clients: Pick<Client, "name" | "engagement_tier" | "match_active"> | null;
  grants: Pick<Grant, "title" | "funder" | "submission_deadline"> | null;
};

export default async function ReviewPage({
  searchParams,
}: {
  searchParams: { filter?: string; paused?: string };
}) {
  await requireUser(); // admins + contractors
  const filter = searchParams.filter || "pending";
  // Paused clients (match_active=false) are hidden from the default queue; ?paused=1 shows them.
  const showPaused = searchParams.paused === "1";
  const supabase = createClient();

  let query = supabase
    .from("review_cards")
    .select("*, clients(name, engagement_tier, match_active), grants(title, funder, submission_deadline)")
    .order("fit_score", { ascending: false })
    // Generic-over-specific demote: within a fit tier, an inferred-nexus card (generic_nexus_flagged)
    // sinks below genuine execution-conditional ones. Inert while every row is false (flag OFF).
    .order("generic_nexus_flagged", { ascending: true })
    .order("created_at", { ascending: false });
  if (filter !== "all") query = query.eq("decision", filter);

  const { data } = await query;
  const allCards = (data ?? []) as Row[];
  // Hide paused clients' matches from the default view (reversible; nothing deleted). The count is
  // taken from the full set so "Show paused (N)" is accurate whether or not they're currently shown.
  const { visible: cards, pausedCount } = filterPausedCards(allCards, showPaused);
  const pausedHref = (next: boolean) =>
    `/review?filter=${filter}${next ? "&paused=1" : ""}`;

  return (
    <div>
      <PageHeader
        title="Review Queue"
        description="Score 2–3 matches. Approve to clear for a client, or pass."
      />
      <div className="space-y-4 p-8">
        <div className="flex flex-wrap items-center gap-2">
          {FILTERS.map((f) => (
            <Link
              key={f.value}
              href={`/review?filter=${f.value}${showPaused ? "&paused=1" : ""}`}
              className={`rounded-md px-3 py-1.5 text-sm font-medium ${
                filter === f.value
                  ? "bg-primary text-primary-foreground"
                  : "border bg-card text-muted-foreground hover:bg-accent/60"
              }`}
            >
              {f.label}
            </Link>
          ))}
          {/* Paused-client toggle. Text-labeled (never colour-only): the link text states the
              action and the count, and a shown paused row carries a "Paused" text badge. Only
              rendered when there is something to toggle. */}
          {(pausedCount > 0 || showPaused) && (
            <Link
              href={pausedHref(!showPaused)}
              className="ml-auto rounded-md border bg-card px-3 py-1.5 text-sm font-medium text-muted-foreground hover:bg-accent/60"
            >
              {showPaused ? "Hide paused clients" : `Show paused (${pausedCount})`}
            </Link>
          )}
        </div>

        <div className="overflow-hidden rounded-lg border bg-card">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b bg-muted/50 text-left text-xs uppercase tracking-wide text-muted-foreground">
                <th className="px-4 py-3 font-medium">Client</th>
                <th className="px-4 py-3 font-medium">Opportunity</th>
                <th className="px-4 py-3 font-medium">Role</th>
                <th className="px-4 py-3 font-medium">Fit</th>
                <th className="px-4 py-3 font-medium">Status</th>
              </tr>
            </thead>
            <tbody>
              {cards.map((c) => (
                <tr key={c.id} className="border-b last:border-0 hover:bg-muted/30">
                  <td className="px-4 py-3">
                    <Link href={`/review/${c.id}`} className="font-medium hover:underline">
                      {c.clients?.name || "Client"}
                    </Link>
                    {/* Text label, not colour-only: a paused-client row (only visible under "Show
                        paused") is marked so its stale matches are obviously not live matching. */}
                    {isPausedClientCard(c) && (
                      <span className="ml-2 rounded border px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                        Paused
                      </span>
                    )}
                    {c.clients?.engagement_tier && (
                      <p className="text-xs text-muted-foreground">{c.clients.engagement_tier}</p>
                    )}
                  </td>
                  <td className="px-4 py-3 max-w-[20rem]">
                    <p className="truncate">{c.grants?.title || "—"}</p>
                    <p className="text-xs text-muted-foreground">{c.grants?.funder}</p>
                  </td>
                  <td className="px-4 py-3 text-muted-foreground">{c.proposed_role}</td>
                  <td className="px-4 py-3"><ScoreBadge score={c.fit_score} /></td>
                  <td className="px-4 py-3"><DecisionBadge decision={c.decision} /></td>
                </tr>
              ))}
              {cards.length === 0 && (
                <tr>
                  <td colSpan={5} className="px-4 py-12 text-center text-muted-foreground">
                    {!showPaused && pausedCount > 0 ? (
                      <>
                        Nothing here — {pausedCount} paused{" "}
                        {pausedCount === 1 ? "match is" : "matches are"} hidden.{" "}
                        <Link href={pausedHref(true)} className="underline hover:no-underline">
                          Show paused
                        </Link>
                      </>
                    ) : (
                      "Nothing here. Matches appear after a grant is ingested."
                    )}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
