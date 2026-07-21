import Link from "next/link";
import { requireAdmin } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { NavyHero } from "@/components/ui/navy-hero";
import { Card } from "@/components/ui/card";
import { ListGroup, ListGroupHeader, ListGroupRow } from "@/components/ui/list-group";
import { Badge } from "@/components/ui/badge";
import { getProspectFeed } from "@/lib/grants/gate";

export const dynamic = "force-dynamic";

// Prospects = Track 2 (BizDev), admin-only. A grant-centric FEED of opportunities
// cleared by the client-first gate for prospecting. Each row links into its own
// detail (/intel/[id]) where the grant facts, the carry-over note, the surfaced
// prospects and the Prospect action live -- this list stays a lean index. Same
// visual language as the Matches queue: navy hero + a single hairline ListGroup.
export default async function IntelPage() {
  await requireAdmin();
  const supabase = createClient();
  const feed = await getProspectFeed(supabase);

  return (
    <div className="space-y-6 p-6">
      <NavyHero
        eyebrow="Prospecting"
        title="Prospects"
        subtitle="Track 2 — grants cleared for prospecting (no client match, or every client match decided). Open a grant to see its shred, surfaced prospects, and the Prospect action."
      >
        <div className="flex items-center gap-2 border-t border-white/12 pt-5 text-sm text-white/70">
          <span className="font-semibold text-white">{feed.length}</span>
          <span>grant{feed.length === 1 ? "" : "s"} cleared for prospecting</span>
        </div>
      </NavyHero>

      {feed.length === 0 ? (
        <Card className="py-16 text-center text-sm text-muted-foreground">
          No grants are ready to prospect yet. A grant appears here once it has been
          scored and any client matches are decided.
        </Card>
      ) : (
        <ListGroup>
          <ListGroupHeader
            title="Cleared for prospecting"
            right={
              <span className="rounded-full bg-brand-navy px-3 py-1 text-xs font-semibold text-white">
                {feed.length}
              </span>
            }
          />
          {feed.map((item) => {
            const sub = [
              item.grant.funder,
              item.grant.submission_deadline ? `deadline ${item.grant.submission_deadline}` : null,
            ]
              .filter(Boolean)
              .join(" · ");
            return (
              <ListGroupRow key={item.grant.id}>
                <div className="grid grid-cols-[1fr_auto] items-center gap-4">
                  <div className="min-w-0">
                    <Link
                      href={`/intel/${item.grant.id}`}
                      className="block truncate text-sm font-medium text-brand-navy hover:underline"
                    >
                      {item.grant.title || "Untitled opportunity"}
                    </Link>
                    <p className="mt-0.5 truncate text-xs text-muted-foreground">{sub || "—"}</p>
                  </div>
                  <div className="flex shrink-0 items-center gap-2">
                    {item.prospectCards.length > 0 && (
                      <span className="rounded-full bg-brand-navy px-3 py-1 text-xs font-semibold text-white">
                        {item.prospectCards.length} prospect{item.prospectCards.length === 1 ? "" : "s"}
                      </span>
                    )}
                    {item.clientMatches.length === 0 ? (
                      <Badge variant="accent">Open to prospect</Badge>
                    ) : (
                      <Badge variant="secondary">
                        {item.clientMatches.length} client{item.clientMatches.length === 1 ? "" : "s"} matched
                      </Badge>
                    )}
                  </div>
                </div>
              </ListGroupRow>
            );
          })}
        </ListGroup>
      )}
    </div>
  );
}
