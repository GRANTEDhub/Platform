import Link from "next/link";
import { notFound } from "next/navigation";
import { requireAdmin } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { PageHeader } from "@/components/layout/page-header";
import { Badge } from "@/components/ui/badge";
import { GrantStatusBadge, ScoreBadge, DecisionBadge } from "@/components/grants/badges";
import { GrantBody, SectionLabel } from "@/components/grants/grant-detail";
import { MatchOutcomes, type OutcomeCard } from "@/components/grants/match-outcomes";
import { getGrantGateStatus, undecidedClientCount } from "@/lib/grants/gate";
import { getSentAlertsByCards } from "@/lib/alerts/sent-status";
import { interTight, sourceSerif } from "@/lib/fonts";
import { ProspectButton } from "../prospect-button";
import { CloseProspectingButton } from "../close-prospecting-button";
import type { Grant, ReviewCard, Client, Prospect } from "@/types/database";

export const dynamic = "force-dynamic";

// The Prospects detail (Track 2): a prospect-appropriate view of one grant. The
// grant body reuses the shared styled grant-detail blocks (same look as the
// Matches review Grant tab); the prospecting-specific surface -- the discovered
// non-client orgs, the client-first gate, the carry-over of who among our clients
// matched -- is unique to this page and lives around it. NO client-match decision
// panel and NO Grant/Match tabs (there is no single client context here).
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

  const carryOver: OutcomeCard[] = clientCards.map((c) => ({
    id: c.id,
    name: c.clients?.name ?? null,
    decision: c.decision,
    sent_at: c.sent_at,
    proposed_role: c.proposed_role,
    recommended_prime: c.recommended_prime,
  }));

  return (
    <div className={`${interTight.variable} ${sourceSerif.variable}`}>
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

      <div className="min-h-full bg-brand-cream">
        <div className="grid grid-cols-1 gap-6 px-6 py-7 sm:px-8 lg:grid-cols-[minmax(0,1fr)_330px] lg:items-start">
          {/* MAIN: styled grant body + the unique prospects list. */}
          <div className="space-y-6">
            <main className="rounded-2xl border border-brand-navy/10 bg-white p-6 sm:p-8">
              {grant.grant_status === "Forecasted" ? (
                <p className="text-sm text-muted-foreground">Forecasted — no NOFO published yet.</p>
              ) : grant.shred_depth === "summary" && grant.shred_reason ? (
                <p className="mb-4 text-xs text-muted-foreground">Summary shred only — {grant.shred_reason}</p>
              ) : null}
              <GrantBody grant={grant} />
            </main>

            {/* Prospects — the discovered non-client orgs (unique to this page). */}
            <div className="rounded-2xl border border-brand-navy/10 bg-white p-6 sm:p-8">
              <div className="flex items-center justify-between gap-3">
                <SectionLabel>Prospects ({prospectCards.length})</SectionLabel>
                {grant.prospecting_closed_at ? (
                  <Badge variant="warning">Closed for prospecting</Badge>
                ) : (
                  <div className="flex items-center gap-2">
                    {gate === "released" && grant.is_domestic && <ProspectButton grantId={grant.id} />}
                    <CloseProspectingButton grantId={grant.id} />
                  </div>
                )}
              </div>

              {grant.prospecting_closed_at && (
                <p className="mt-3 text-sm text-muted-foreground">
                  Closed for prospecting — removed from the prospect feed. History below is read-only; reopen from the Ledger.
                </p>
              )}

              {gate !== "released" ? (
                <p className="mt-3 text-sm text-muted-foreground">
                  {gate === "not_ready"
                    ? "Not ready — this grant has not finished scoring against the roster."
                    : `Locked — ${undecided} client ${undecided === 1 ? "match is" : "matches are"} undecided. Clients get first dibs before prospecting.`}
                </p>
              ) : prospectCards.length === 0 ? (
                <p className="mt-3 text-sm text-muted-foreground">
                  No prospects surfaced yet. Run Prospect to search for fitting non-client orgs.
                </p>
              ) : (
                <ul className="mt-2 divide-y divide-brand-navy/[0.08] text-sm">
                  {prospectCards.map((pc) => (
                    <li key={pc.id} className="flex items-center justify-between gap-3 py-3.5">
                      <Link href={`/review/${pc.id}`} className="min-w-0 truncate font-medium text-brand-navy hover:underline">
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
            </div>
          </div>

          {/* SIDEBAR: prospecting-only (grant facts folded into the body above). */}
          <aside className="space-y-4">
            <div className="rounded-2xl border border-brand-navy/10 bg-white p-4">
              <SectionLabel>Prospecting</SectionLabel>
              <div className="mt-3 flex items-start gap-2.5 text-sm text-muted-foreground">
                {gate === "not_ready" && <p>Not ready — grant has not finished scoring against the roster.</p>}
                {gate === "released" && (
                  <>
                    <Badge variant="success">Released</Badge>
                    <span>Free to prospect — every client match is decided (or there are none).</span>
                  </>
                )}
                {gate === "locked" && (
                  <>
                    <Badge variant="warning">Locked</Badge>
                    <span>{undecided} client {undecided === 1 ? "match" : "matches"} undecided — clients get first dibs.</span>
                  </>
                )}
              </div>
            </div>

            <div className="rounded-2xl border border-brand-navy/10 bg-white p-4">
              <SectionLabel>Also matched · clients</SectionLabel>
              <div className="mt-3">
                <MatchOutcomes cards={carryOver} emptyText="No client matches on this grant." />
              </div>
            </div>
          </aside>
        </div>
      </div>
    </div>
  );
}
