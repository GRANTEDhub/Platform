import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import { requireAdmin } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { NavyHero } from "@/components/ui/navy-hero";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { ScoreBadge, DecisionBadge } from "@/components/grants/badges";
import {
  GrantBody,
  GrantStatTiles,
  GrantStatusPill,
  WhoCanApply,
  SectionLabel,
} from "@/components/grants/grant-detail";
import { MatchOutcomes, type OutcomeCard } from "@/components/grants/match-outcomes";
import { getGrantGateStatus, undecidedClientCount } from "@/lib/grants/gate";
import { getSentAlertsByCards } from "@/lib/alerts/sent-status";
import { ProspectButton } from "../prospect-button";
import { CloseProspectingButton } from "../close-prospecting-button";
import type { Grant, ReviewCard, Client, Prospect } from "@/types/database";

export const dynamic = "force-dynamic";

// The Prospects detail (Track 2): a prospect-appropriate view of one grant. The top
// reads exactly like the Matches "The Grant" tab -- navy hero + hero stat tiles, the
// shared GrantBody facts, Who-Can-Apply floated into the rail. The ONLY difference is
// the prospecting-specific surface at the bottom: the discovered non-client orgs + the
// Prospect action, the client-first gate, and the carry-over of who among our clients
// matched. NO client-match decision panel and NO Grant/Match tabs (no single client
// context here).
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

  // Derive the "Alerted" state from grant_alerts (one batched query for all
  // prospect cards -- no N+1, no migration).
  const sentByCard = await getSentAlertsByCards(prospectCards.map((c) => c.id));

  const gate = getGrantGateStatus(grant, all);
  const undecided = undecidedClientCount(all);
  // A client actively pursuing this grant is the one case worth a loud warning
  // before reaching out to an outside org (potential conflict). Prospecting is
  // otherwise never held by client decisions.
  const pursuing = clientCards.filter((c) => c.decision === "approved").length;

  const carryOver: OutcomeCard[] = clientCards.map((c) => ({
    id: c.id,
    name: c.clients?.name ?? null,
    decision: c.decision,
    sent_at: c.sent_at,
    proposed_role: c.proposed_role,
    recommended_prime: c.recommended_prime,
  }));

  return (
    <div className="min-h-full bg-page px-6 py-7 sm:px-8">
      <Link
        href="/intel/grants"
        className="mb-4 inline-flex items-center gap-1.5 text-sm font-medium text-muted-foreground transition-colors hover:text-brand-navy"
      >
        <ArrowLeft className="h-4 w-4" />
        Grant prospecting
      </Link>
      <NavyHero
        eyebrow="Prospecting"
        eyebrowRight={<GrantStatusPill status={grant.grant_status} />}
        title={grant.title || "Untitled opportunity"}
        subtitle={[grant.funder, grant.fon].filter(Boolean).join(" · ") || "—"}
        actions={
          <div className="flex flex-col items-end gap-2">
            {!grant.is_domestic && <Badge variant="warning">International — excluded</Badge>}
            <Badge variant={grant.shred_depth === "full" ? "success" : "warning"}>
              {grant.shred_depth === "full" ? "Full shred" : "Summary shred"}
            </Badge>
          </div>
        }
      >
        <GrantStatTiles grant={grant} tone="onHero" />
      </NavyHero>

      <div className="mt-6 grid grid-cols-1 gap-6 lg:grid-cols-[minmax(0,1fr)_330px] lg:items-start">
        {/* MAIN: grant facts (identical to The Grant tab), then the prospecting section. */}
        <main className="min-w-0 space-y-6">
          {grant.grant_status === "Forecasted" ? (
            <p className="text-sm text-muted-foreground">Forecasted — no NOFO published yet.</p>
          ) : grant.shred_depth === "summary" && grant.shred_reason ? (
            <p className="text-xs text-muted-foreground">Summary shred only — {grant.shred_reason}</p>
          ) : null}

          <GrantBody grant={grant} showStats={false} showWhoCanApply={false} />

          {/* Prospects — the discovered non-client orgs + the Prospect action. The one
              piece "The Grant" page doesn't have; it sits at the bottom of the facts. */}
          <Card className="p-6 sm:p-8">
            <div className="flex items-center justify-between gap-3">
              <SectionLabel>Prospects ({prospectCards.length})</SectionLabel>
              {grant.prospecting_closed_at ? (
                <Badge variant="warning">Closed for prospecting</Badge>
              ) : (
                <div className="flex items-center gap-2">
                  {gate !== "not_ready" && grant.is_domestic && <ProspectButton grantId={grant.id} />}
                  <CloseProspectingButton grantId={grant.id} />
                </div>
              )}
            </div>

            {grant.prospecting_closed_at && (
              <p className="mt-3 text-sm text-muted-foreground">
                Closed for prospecting — removed from the prospect feed. History below is read-only; reopen from the Ledger.
              </p>
            )}

            {gate === "not_ready" ? (
              <p className="mt-3 text-sm text-muted-foreground">
                Not scored yet — this grant hasn&apos;t finished scoring against the roster, so there&apos;s no
                profile to discover prospects from.
              </p>
            ) : prospectCards.length === 0 ? (
              <p className="mt-3 text-sm text-muted-foreground">
                No prospects surfaced yet. Run Prospect to search for fitting non-client orgs.
              </p>
            ) : (
              <ul className="mt-2 divide-y divide-brand-navy/[0.08] text-sm">
                {prospectCards.map((pc) => (
                  <li key={pc.id} className="flex items-center justify-between gap-3 py-3.5">
                    <Link
                      href={`/review/${pc.id}`}
                      className="min-w-0 truncate font-medium text-brand-navy hover:underline"
                    >
                      {pc.prospects?.name || "Prospect org"}
                    </Link>
                    <div className="flex shrink-0 items-center gap-2">
                      <ScoreBadge score={(pc.fit_score ?? 2) as 1 | 2 | 3} />
                      {sentByCard.has(pc.id) ? (
                        <Badge variant="success">✓ Alerted</Badge>
                      ) : (
                        <DecisionBadge decision={pc.decision} />
                      )}
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </main>

        {/* RAIL: Who-can-apply (as on The Grant tab) + the prospecting gate + carry-over. */}
        <aside className="space-y-4">
          <WhoCanApply grant={grant} dense />

          <Card className="p-5">
            <SectionLabel>Client-match status</SectionLabel>
            <div className="mt-3 flex items-start gap-2.5 text-sm text-muted-foreground">
              {gate === "not_ready" ? (
                <p>Not scored yet — can&apos;t prospect until it&apos;s evaluated against the roster.</p>
              ) : pursuing > 0 ? (
                <>
                  <Badge variant="warning">Client pursuing</Badge>
                  <span>
                    {pursuing} client {pursuing === 1 ? "is" : "are"} actively pursuing this — reaching out to
                    an outside org may conflict. See &ldquo;Also matched&rdquo; below.
                  </span>
                </>
              ) : clientCards.length > 0 ? (
                <>
                  <Badge variant="secondary">Matched</Badge>
                  <span>
                    Matched to {clientCards.length} client{clientCards.length === 1 ? "" : "s"} (see below)
                    {undecided > 0 ? ", some still deciding" : ", all decided"}. Not held — free to prospect.
                  </span>
                </>
              ) : (
                <>
                  <Badge variant="accent">Open</Badge>
                  <span>No client match — open to prospect.</span>
                </>
              )}
            </div>
          </Card>

          <Card className="p-5">
            <SectionLabel>Also matched · clients</SectionLabel>
            <div className="mt-3">
              <MatchOutcomes cards={carryOver} emptyText="No client matches on this grant." />
            </div>
          </Card>
        </aside>
      </div>
    </div>
  );
}
