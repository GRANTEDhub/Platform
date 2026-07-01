import Link from "next/link";
import { notFound } from "next/navigation";
import { requireAdmin } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { PageHeader } from "@/components/layout/page-header";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { GrantStatusBadge, ScoreBadge, DecisionBadge } from "@/components/grants/badges";
import { GrantOverview, GrantKeyFacts } from "@/components/grants/grant-facts";
import { MatchOutcomes, type OutcomeCard } from "@/components/grants/match-outcomes";
import { getGrantGateStatus, undecidedClientCount } from "@/lib/grants/gate";
import { ProspectButton } from "../prospect-button";
import type { Grant, ReviewCard, Client, Prospect } from "@/types/database";

export const dynamic = "force-dynamic";

// The Prospects detail (Track 2): a prospect-appropriate view of one grant --
// grant facts, the carry-over note (who among our clients matched + result), the
// prospect surface (discovered non-client orgs) and the Prospect action. The
// client-first gate lives here (it governs prospecting). NO re-match / re-shred:
// those are calibration tools and live on the Ledger detail, off this path.
type CardRow = ReviewCard & {
  clients: Pick<Client, "id" | "name"> | null;
  prospects: Pick<Prospect, "id" | "name" | "org_type" | "source_url"> | null;
};

export default async function ProspectDetailPage({ params }: { params: { id: string } }) {
  await requireAdmin(); // Track 2 is admin-only, same as the Prospects list
  const supabase = createClient();

  const { data: grant } = await supabase
    .from("grants")
    .select("*")
    .eq("id", params.id)
    .single<Grant>();

  if (!grant) notFound();

  const { data: cards } = await supabase
    .from("review_cards")
    .select("*, clients(id, name), prospects(id, name, org_type, source_url)")
    .eq("grant_id", params.id)
    .order("fit_score", { ascending: false });

  const all = (cards ?? []) as CardRow[];
  const clientCards = all.filter((c) => c.card_type !== "prospect");
  const prospectCards = all.filter((c) => c.card_type === "prospect");

  const gate = getGrantGateStatus(grant, all);
  const undecided = undecidedClientCount(all);

  const carryOver: OutcomeCard[] = clientCards.map((c) => ({
    id: c.id,
    name: c.clients?.name ?? null,
    decision: c.decision,
    sent_at: c.sent_at,
    proposed_role: c.proposed_role,
    recommended_prime: c.recommended_prime,
  }));

  return (
    <div>
      <PageHeader
        title={grant.title || "Untitled opportunity"}
        description={[grant.funder, grant.fon].filter(Boolean).join(" · ") || undefined}
        action={
          <div className="flex items-center gap-2">
            {!grant.is_domestic && <Badge variant="warning">International — excluded</Badge>}
            <Badge variant={grant.shred_depth === "full" ? "success" : "warning"}>
              {grant.shred_depth === "full" ? "Full shred" : "Summary shred"}
            </Badge>
            <GrantStatusBadge status={grant.status} />
          </div>
        }
      />

      <div className="grid gap-6 p-8 lg:grid-cols-3">
        <div className="space-y-6 lg:col-span-2">
          <GrantOverview grant={grant} />

          <Card>
            <CardHeader className="flex-row items-center justify-between space-y-0">
              <CardTitle>Prospects ({prospectCards.length})</CardTitle>
              {/* Client-first: only prospect once every client match is decided. */}
              {gate === "released" && grant.is_domestic && <ProspectButton grantId={grant.id} />}
            </CardHeader>
            <CardContent>
              {gate !== "released" ? (
                <p className="text-sm text-muted-foreground">
                  {gate === "not_ready"
                    ? "Not ready — this grant has not finished scoring against the roster."
                    : `Locked — ${undecided} client ${undecided === 1 ? "match is" : "matches are"} undecided. Clients get first dibs before prospecting.`}
                </p>
              ) : prospectCards.length === 0 ? (
                <p className="text-sm text-muted-foreground">
                  No prospects surfaced yet. Run Prospect to search for fitting non-client orgs.
                </p>
              ) : (
                <ul className="divide-y text-sm">
                  {prospectCards.map((pc) => (
                    <li key={pc.id} className="flex items-center justify-between gap-3 py-3">
                      <div className="min-w-0">
                        {/* Prospect cards ARE the actionable surface -> the review
                            page is where a prospect is worked (Matches' decision
                            surface serves prospect cards too). */}
                        <Link href={`/review/${pc.id}`} className="font-medium hover:underline">
                          {pc.prospects?.name || "Prospect org"}
                        </Link>
                        <p className="truncate text-xs text-muted-foreground">
                          {pc.proposed_role}
                          {pc.prospects?.source_url ? (
                            <>
                              {" · "}
                              <a
                                href={pc.prospects.source_url}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="text-primary hover:underline"
                              >
                                source ↗
                              </a>
                            </>
                          ) : null}
                        </p>
                      </div>
                      <div className="flex shrink-0 items-center gap-2">
                        <ScoreBadge score={(pc.fit_score ?? 2) as 1 | 2 | 3} />
                        <DecisionBadge decision={pc.decision} />
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </CardContent>
          </Card>
        </div>

        <div className="space-y-6">
          <Card>
            <CardHeader><CardTitle>Prospecting</CardTitle></CardHeader>
            <CardContent className="space-y-1 text-sm">
              {gate === "not_ready" && (
                <p className="text-muted-foreground">
                  Not ready — grant has not finished scoring against the roster.
                </p>
              )}
              {gate === "released" && (
                <div className="flex items-center gap-2">
                  <Badge variant="success">Released</Badge>
                  <span className="text-muted-foreground">
                    Free to prospect — every client match is decided (or there are none).
                  </span>
                </div>
              )}
              {gate === "locked" && (
                <div className="flex items-center gap-2">
                  <Badge variant="warning">Locked</Badge>
                  <span className="text-muted-foreground">
                    {undecided} client {undecided === 1 ? "match" : "matches"} undecided — clients get first dibs.
                  </span>
                </div>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader><CardTitle>Also matched (clients)</CardTitle></CardHeader>
            <CardContent>
              <MatchOutcomes cards={carryOver} emptyText="No client matches on this grant." />
            </CardContent>
          </Card>

          <GrantKeyFacts grant={grant} />
        </div>
      </div>
    </div>
  );
}
