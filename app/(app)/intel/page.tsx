import Link from "next/link";
import { requireAdmin } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { PageHeader } from "@/components/layout/page-header";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { getProspectFeed } from "@/lib/grants/gate";

export const dynamic = "force-dynamic";

// Prospects = Track 2 (BizDev), admin-only. A grant-centric FEED of opportunities
// cleared by the client-first gate for prospecting. Each row links into its own
// detail (/intel/[id]) where the grant facts, the carry-over note, the surfaced
// prospects and the Prospect action live -- this list stays a lean index.
export default async function IntelPage() {
  await requireAdmin();
  const supabase = createClient();
  const feed = await getProspectFeed(supabase);

  return (
    <div>
      <PageHeader
        title="Prospects"
        description="Track 2 — grants cleared for prospecting (no client match, or every client match decided). Open a grant to see its shred, surfaced prospects, and the Prospect action."
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
            <CardHeader className="space-y-0">
              <CardTitle className="truncate">
                <Link href={`/intel/${item.grant.id}`} className="hover:underline">
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
            </CardHeader>
            <CardContent className="space-y-2 text-sm">
              <Link href={`/intel/${item.grant.id}`} className="text-primary hover:underline">
                Open →
              </Link>
              <p className="text-muted-foreground">
                {item.clientMatches.length === 0
                  ? "No client matches — open to prospect."
                  : `Also matched: ${item.clientMatches
                      .map((m) => `${m.name} (${m.decision === "approved" ? "alerted" : "not alerted"})`)
                      .join(", ")}`}
              </p>
              {item.prospectCards.length > 0 && (
                <p className="text-xs text-muted-foreground">
                  {item.prospectCards.length} prospect{item.prospectCards.length === 1 ? "" : "s"} surfaced
                </p>
              )}
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
  );
}
