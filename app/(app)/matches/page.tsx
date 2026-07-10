import Link from "next/link";
import { requireUser } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { NavyHero } from "@/components/ui/navy-hero";
import { Card } from "@/components/ui/card";
import { ListGroup, ListGroupHeader, ListGroupRow } from "@/components/ui/list-group";
import { ScoreBadge, DecisionBadge } from "@/components/grants/badges";
import { groupCardsByOrg, type MatchCard } from "@/lib/grants/grouping";

export const dynamic = "force-dynamic";

// New/All toggle styled for the navy hero (white-on-navy, orange active pill).
function heroTab(active: boolean) {
  return `rounded-lg px-4 py-1.5 text-sm font-semibold transition-colors ${
    active ? "bg-brand-orange text-white" : "text-white/65 hover:text-white"
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
    <div className="space-y-6 p-6">
      <NavyHero
        eyebrow="Grant Matches"
        title="Matches"
        subtitle="New grant matches across the active client roster. Clear the day's queue: open a client, review the match, send or reject."
      >
        <div className="flex items-center justify-between gap-4 border-t border-white/12 pt-5">
          <p className="text-sm text-white/80">
            {showAll ? (
              <>
                <b className="font-semibold text-white">{groups.length}</b>{" "}
                {groups.length === 1 ? "client" : "clients"} with matches
              </>
            ) : (
              <>
                <b className="font-semibold text-white">
                  {totalNew} new {totalNew === 1 ? "match" : "matches"}
                </b>{" "}
                across {groups.length} {groups.length === 1 ? "client" : "clients"}
              </>
            )}
          </p>
          <div className="flex gap-1.5 rounded-xl bg-white/10 p-1">
            <Link href="/matches" className={heroTab(!showAll)}>New</Link>
            <Link href="/matches?filter=all" className={heroTab(showAll)}>All</Link>
          </div>
        </div>
      </NavyHero>

      {groups.length === 0 && (
        <Card className="py-16 text-center text-sm text-muted-foreground">
          {showAll
            ? "No matches yet. They appear here once a grant is ingested and scored against the roster."
            : "Nothing new to review. New matches appear here as grants come in."}
        </Card>
      )}

      {groups.map((g) => (
        <ListGroup key={g.orgId}>
          <ListGroupHeader
            title={
              <Link href={`/clients/${g.orgId}/grants`} className="hover:underline">
                {g.orgName}
              </Link>
            }
            subtitle={g.orgSubtitle}
            right={
              g.newCount > 0 ? (
                <span className="rounded-full bg-brand-navy px-3 py-1 text-xs font-semibold text-white">
                  {g.newCount} new
                </span>
              ) : undefined
            }
          />
          {g.cards.map((c) => (
            <ListGroupRow key={c.id}>
              {/* Fixed score/status/date tracks so the columns align row-to-row
                  within the group; title flexes and truncates. */}
              <div className="grid grid-cols-[1fr_auto] items-center gap-4 sm:grid-cols-[1fr_170px_104px_104px] sm:gap-5">
                <div className="min-w-0">
                  <Link
                    href={`/review/${c.id}`}
                    className="block truncate text-sm font-medium text-brand-navy hover:underline"
                  >
                    {c.grants?.title || "Untitled opportunity"}
                  </Link>
                  <p className="mt-0.5 truncate text-xs text-muted-foreground">
                    {c.grants?.funder}
                    {c.proposed_role ? (
                      <>
                        {" · "}
                        <span className="font-medium">{c.proposed_role}</span>
                      </>
                    ) : null}
                  </p>
                </div>
                <div className="hidden sm:block"><ScoreBadge score={c.fit_score} /></div>
                <div className="hidden sm:block"><DecisionBadge decision={c.decision} /></div>
                <div className="hidden text-right text-xs text-muted-foreground sm:block">
                  {c.grants?.submission_deadline || "—"}
                </div>
              </div>
            </ListGroupRow>
          ))}
        </ListGroup>
      ))}
    </div>
  );
}
