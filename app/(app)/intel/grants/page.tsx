import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { requireAdmin } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { NavyHero } from "@/components/ui/navy-hero";
import { Card } from "@/components/ui/card";
import { ListGroup, ListGroupHeader, ListGroupRow } from "@/components/ui/list-group";
import { Badge } from "@/components/ui/badge";
import { getProspectFeed } from "@/lib/grants/gate";
import { IngestForm } from "@/app/(app)/grants/ingest-form";

export const dynamic = "force-dynamic";

// Grant Prospecting (Track 2, admin-only) — the grant-centric FEED. Reached from the
// Prospecting landing (/intel). Every scored grant with its client-match status; a
// client match no longer holds a grant back. Each row links into its detail
// (/intel/[id]) where the shred, surfaced prospects, and the Prospect action live.
export default async function GrantProspectingPage() {
  await requireAdmin();
  const supabase = createClient();
  const feed = await getProspectFeed(supabase);

  return (
    <div className="space-y-6 p-6">
      <Link
        href="/intel"
        className="inline-flex items-center gap-1.5 text-sm font-medium text-muted-foreground transition-colors hover:text-brand-navy"
      >
        <ArrowLeft className="h-4 w-4" />
        Prospecting
      </Link>
      <NavyHero
        eyebrow="Prospecting"
        title="Grant prospecting"
        subtitle="Track 2 — every scored grant, with its client-match status. A client match no longer holds a grant back: you see who matched and what they decided, then choose whether to reach out. Open a grant for its shred, surfaced prospects, and the Prospect action."
      >
        <div className="flex items-center gap-2 border-t border-white/12 pt-5 text-sm text-white/70">
          <span className="font-semibold text-white">{feed.length}</span>
          <span>grant{feed.length === 1 ? "" : "s"} in prospecting</span>
        </div>
      </NavyHero>

      {/* Analyze on demand — the Ledger's ingest affordance, surfaced here so a prospector
          can score a grant that isn't in the feed yet without bouncing to the Ledger. The
          SAME zero-prop <IngestForm /> the Ledger renders (reused, not forked); it lands on
          the new grant's Ledger record via the existing path. */}
      <Card className="p-6">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
          Analyze on demand
        </h2>
        <p className="mt-1.5 text-sm text-muted-foreground">
          Paste a grant link or NOFO to score a new opportunity against the roster. It opens in the Ledger once analyzed.
        </p>
        <div className="mt-4">
          <IngestForm />
        </div>
      </Card>

      {feed.length === 0 ? (
        <Card className="py-16 text-center text-sm text-muted-foreground">
          No grants to prospect yet. A grant appears here once it has been scored
          against the roster.
        </Card>
      ) : (
        <ListGroup>
          <ListGroupHeader
            title="All scored grants"
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
            // A client actively pursuing this grant is the one case worth a loud
            // flag before we reach out to an outside org (potential conflict).
            const pursuing = item.clientMatches.filter((c) => c.decision === "approved").length;
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
                    {/* Says so on the row rather than letting you find out by pressing
                        Prospect and getting a 400. Discovery maps candidate orgs onto the
                        grant's ideal-applicant profile, so with no profile there is nothing
                        to map onto — the row is here because a missing profile on a
                        will-score grant is a gap worth seeing, not one to hide. */}
                    {!item.prospectable && (
                      <Badge variant="warning" title="No ideal-applicant profile — rebuild the grant profile in the Ledger to make this prospectable">
                        No profile — can&apos;t prospect
                      </Badge>
                    )}
                    {item.prospectCards.length > 0 && (
                      <span className="rounded-full bg-brand-navy px-3 py-1 text-xs font-semibold text-white">
                        {item.prospectCards.length} prospect{item.prospectCards.length === 1 ? "" : "s"}
                      </span>
                    )}
                    {item.clientMatches.length === 0 ? (
                      <Badge variant="accent">Open — no client match</Badge>
                    ) : pursuing > 0 ? (
                      <Badge variant="warning">⚠ {pursuing} client{pursuing === 1 ? "" : "s"} pursuing</Badge>
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
