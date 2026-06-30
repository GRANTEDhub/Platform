import Link from "next/link";
import { requireAdmin } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { PageHeader } from "@/components/layout/page-header";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { getProspectFeed } from "@/lib/grants/gate";

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
              {/* Inert until the discovery engine (step 3). Live discovery runs
                  only on grants the user explicitly flags here. */}
              <button
                type="button"
                disabled
                title="Discovery engine — coming in step 3"
                className="shrink-0 cursor-not-allowed rounded-md border bg-muted px-3 py-1.5 text-sm font-medium text-muted-foreground opacity-60"
              >
                Prospect
              </button>
            </CardHeader>
            <CardContent className="space-y-2 text-sm">
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
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
  );
}
