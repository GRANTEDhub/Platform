import Link from "next/link";
import { requireUser } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { PageHeader } from "@/components/layout/page-header";
import { MatchRow } from "@/components/grants/match-row";
import { groupCardsByOrg, type MatchCard } from "@/lib/grants/grouping";

export const dynamic = "force-dynamic";

function tab(active: boolean) {
  return `rounded-md px-3 py-1.5 text-sm font-medium ${
    active
      ? "bg-primary text-primary-foreground"
      : "border bg-card text-muted-foreground hover:bg-accent/60"
  }`;
}

export default async function MatchingPage({
  searchParams,
}: {
  searchParams: { filter?: string };
}) {
  await requireUser(); // admins + contractors work the queue
  const showAll = searchParams.filter === "all";
  const supabase = createClient();

  let query = supabase
    .from("review_cards")
    .select(
      "*, clients(id, name, org_type, engagement_tier), grants(id, title, funder, submission_deadline, deadline)",
    )
    .order("fit_score", { ascending: false })
    .order("created_at", { ascending: false });
  if (!showAll) query = query.eq("decision", "pending");

  const { data } = await query;
  const groups = groupCardsByOrg((data ?? []) as MatchCard[]);
  const totalNew = groups.reduce((s, g) => s + g.newCount, 0);

  return (
    <div>
      <PageHeader
        title="Matches"
        description="New grant matches across the active client roster. Clear the day's queue: open a client, review the match, send or reject."
      />
      <div className="space-y-6 p-8">
        <div className="flex items-center justify-between">
          <p className="text-sm text-muted-foreground">
            {showAll
              ? `${groups.length} ${groups.length === 1 ? "client" : "clients"} with matches`
              : `${totalNew} new ${totalNew === 1 ? "match" : "matches"} across ${groups.length} ${groups.length === 1 ? "client" : "clients"}`}
          </p>
          <div className="flex gap-2">
            <Link href="/matches" className={tab(!showAll)}>New</Link>
            <Link href="/matches?filter=all" className={tab(showAll)}>All</Link>
          </div>
        </div>

        {groups.length === 0 && (
          <div className="rounded-lg border border-dashed bg-card py-16 text-center text-sm text-muted-foreground">
            {showAll
              ? "No matches yet. They appear here once a grant is ingested and scored against the roster."
              : "Nothing new to review. New matches appear here as grants come in."}
          </div>
        )}

        {groups.map((g) => (
          <section key={g.orgId} className="overflow-hidden rounded-lg border bg-card">
            <div className="flex items-center justify-between border-b bg-muted/40 px-4 py-3">
              <div>
                <Link href={`/clients/${g.orgId}/grants`} className="font-semibold hover:underline">
                  {g.orgName}
                </Link>
                {g.orgSubtitle && (
                  <span className="ml-2 text-xs text-muted-foreground">{g.orgSubtitle}</span>
                )}
              </div>
              {g.newCount > 0 && (
                <span className="rounded-full bg-primary px-2.5 py-0.5 text-xs font-semibold text-primary-foreground">
                  {g.newCount} new
                </span>
              )}
            </div>
            <table className="w-full text-sm">
              <tbody>
                {g.cards.map((c) => <MatchRow key={c.id} card={c} />)}
              </tbody>
            </table>
          </section>
        ))}
      </div>
    </div>
  );
}
