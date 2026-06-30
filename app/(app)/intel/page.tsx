import Link from "next/link";
import { requireAdmin } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { PageHeader } from "@/components/layout/page-header";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ScoreBadge, DecisionBadge } from "@/components/grants/badges";
import { getProspectFeed } from "@/lib/grants/gate";
import { ProspectButton } from "./prospect-button";

export const dynamic = "force-dynamic";

// Grant Intel = Track 2 (prospects / BizDev), admin-only. Grant-centric list of
// grants cleared by the client-first gate for prospecting, each carrying a note
// of which clients matched and whether they were alerted. The shred is reused
// via the existing /grants/[id] view. The Prospect button is present but inert
// until the discovery engine (step 3) is built.
export default async function IntelPage() {
  await requireAdmin();
  const supabase = createClient();
  const feed = await getProspectFeed(supabase);

  return (
    <div>
      <PageHeader
        title="Grant Intel"
        description="Track 2 — grants cleared for prospecting (no client match, or every client match decided). Open a grant's shred, then Prospect to surface non-client orgs."
      />
      <div className="space-y-4 p-8">
        {feed.length === 0 && (
          <div className="rounded-lg border border-dashed bg-card py-16 text-center text-sm text-muted-foreground">
            No grants are ready to prospect yet. A grant appears here once it has been
            scored and any client matches are decided.
          </div>
        )}

        {feed.map((item) => (
          <Card key={item.grant.id}>
            <CardHeader className="flex-row items-start justify-between gap-4 space-y-0">
              <div className="min-w-0">
                <CardTitle className="truncate">
                  <Link href={`/grants/${item.grant.id}`} className="hover:underline">
                    {item.grant.title || "Untitled opportunity"}
                  </Link>
                </CardTitle>
                <p className="mt-1 text-xs text-muted-foreground">
                  {[
                    item.grant.funder,
                    item.grant.submission_deadline
                      ? `deadline ${item.grant.submission_deadline}`
                      : null,
                  ]
                    .filter(Boolean)
                    .join(" · ")}
                </p>
              </div>
              {/* Live discovery runs only on grants the user explicitly flags. */}
              <ProspectButton grantId={item.grant.id} />
            </CardHeader>
            <CardContent className="space-y-3 text-sm">
              <Link href={`/grants/${item.grant.id}`} className="text-primary hover:underline">
                Open shred →
              </Link>
              <p className="text-muted-foreground">
                {item.clientMatches.length === 0
                  ? "No client matches — open to prospect."
                  : `Also matched: ${item.clientMatches
                      .map((m) => `${m.name} (${m.decision === "approved" ? "alerted" : "not alerted"})`)
                      .join(", ")}`}
              </p>

              {item.prospectCards.length > 0 && (
                <div className="rounded-md border">
                  <p className="border-b bg-muted/40 px-3 py-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
                    Surfaced prospects ({item.prospectCards.length})
                  </p>
                  <ul className="divide-y">
                    {item.prospectCards.map((pc) => (
                      <li key={pc.id} className="flex items-center justify-between gap-3 px-3 py-2">
                        <div className="min-w-0">
                          <Link href={`/review/${pc.id}`} className="font-medium hover:underline">
                            {pc.prospect?.name || "Prospect org"}
                          </Link>
                          <p className="truncate text-xs text-muted-foreground">
                            {pc.proposed_role}
                            {pc.prospect?.source_url ? (
                              <>
                                {" · "}
                                <a
                                  href={pc.prospect.source_url}
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
                </div>
              )}
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
  );
}
