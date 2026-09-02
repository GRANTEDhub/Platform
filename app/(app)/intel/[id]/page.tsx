import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import { requireAdmin } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { ScoreBadge, DecisionBadge, GrantStatusBadge } from "@/components/grants/badges";
import {
  WhatItFunds,
  WhoCanApply,
  MakeOrBreak,
  IdealApplicantProfile,
  AdditionalInformation,
  RiskFactors,
  SectionLabel,
} from "@/components/grants/grant-detail";
import { OverviewCard } from "@/components/report/grant-review-console";
import { buildGrantSummary } from "@/lib/report/grant-summary";
import { MatchOutcomes, type OutcomeCard } from "@/components/grants/match-outcomes";
import { getGrantGateStatus, undecidedClientCount } from "@/lib/grants/gate";
import { RematchButton } from "@/app/(app)/grants/[id]/rematch-button";
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
    .order("fit_score", { ascending: false })
    // Generic-over-specific demote: an inferred-nexus card sinks within its fit tier. Inert while
    // every row is false (flag OFF). Prospect cards are never flagged today (the classifier hooks the
    // client-match path only), so they sort exactly as before.
    .order("generic_nexus_flagged", { ascending: true });

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

  // Why this grant cannot be prospected, or null when it can. Mirrors getProspectFeed's
  // own exclusions (gate.ts), which is what makes reaching this page for such a grant
  // possible at all — the FEED filters these out, so you only land here from a stale tab,
  // a bookmark, or the back button after a re-shred changed the answer underneath you.
  //
  // Order matters: the international exclusion is policy and never re-decidable, so it
  // outranks the suppression gate, which is a heuristic a fresh shred can revise.
  const blockedReason: string | null = !grant.is_domestic
    ? "International — excluded by GRANTED's domestic-only policy."
    : (grant.hard_disqualifiers?.length ?? 0) > 0
      ? grant.hard_disqualifiers!.join("; ")
      : grant.skip_reason
        ? grant.skip_reason
        : // LAST, because it is the only one of these a rebuild can actually clear.
          // Discovery maps candidate orgs onto the ideal-applicant profile, so with no
          // profile there are no seats to map onto and discoverProspects refuses. The gate
          // reasons above are policy or a deliberate suppression; this one is a gap.
          !grant.ideal_applicant_profile
          ? "No ideal-applicant profile was built for this grant, so there are no seats to match candidate orgs against."
          : null;

  // In flight — the same three non-terminal statuses the Ledger detail treats as
  // processing (Move 2's queue adds 'queued' and 'matching' alongside 'processing').
  const inFlight =
    grant.status === "processing" || grant.status === "queued" || grant.status === "matching";

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
      {/* Slim header — OverviewCard below owns the grant title + funder line + the facts strip
          (matching the grant report, which has no separate title hero). Back-nav (above) and the
          status / shred / international badges stay, each with a text label so meaning never rides
          on colour alone. */}
      <div className="flex flex-wrap items-center gap-2">
        {!grant.is_domestic && <Badge variant="warning">International — excluded</Badge>}
        <Badge variant={grant.shred_depth === "full" ? "success" : "warning"}>
          {grant.shred_depth === "full" ? "Full shred" : "Summary shred"}
        </Badge>
        <GrantStatusBadge status={grant.status} grantStatus={grant.grant_status} />
      </div>

      <div className="mt-6 grid grid-cols-1 gap-6 lg:grid-cols-[minmax(0,1fr)_330px] lg:items-start">
        {/* MAIN: grant facts (identical to The Grant tab), then the prospecting section. */}
        <main className="min-w-0 space-y-6">
          {grant.grant_status === "Forecasted" ? (
            <p className="text-sm text-muted-foreground">Forecasted — no NOFO published yet.</p>
          ) : grant.shred_depth === "summary" && grant.shred_reason ? (
            <p className="text-xs text-muted-foreground">Summary shred only — {grant.shred_reason}</p>
          ) : null}

          {/* Grant SUMMARY via the shared OverviewCard (grant-level: no client, no role pill). The FULL,
              expandable description follows in "What it funds" (OverviewCard's summary is null — its blurb
              truncates with no expander), then the deeper staff-analysis blocks. */}
          <OverviewCard {...buildGrantSummary(grant)} />
          <WhatItFunds grant={grant} />
          <MakeOrBreak grant={grant} />
          <IdealApplicantProfile grant={grant} />
          <AdditionalInformation grant={grant} />
          <RiskFactors grant={grant} />

          {/* Prospects — the discovered non-client orgs + the Prospect action. The one
              piece "The Grant" page doesn't have; it sits at the bottom of the facts. */}
          <Card className="p-6 sm:p-8">
            <div className="flex items-center justify-between gap-3">
              <SectionLabel>Prospects ({prospectCards.length})</SectionLabel>
              {grant.prospecting_closed_at ? (
                <Badge variant="warning">Closed for prospecting</Badge>
              ) : (
                <div className="flex items-center gap-2">
                  {gate !== "not_ready" && !blockedReason && <ProspectButton grantId={grant.id} />}
                  <CloseProspectingButton grantId={grant.id} />
                </div>
              )}
            </div>

            {grant.prospecting_closed_at && (
              <p className="mt-3 text-sm text-muted-foreground">
                Closed for prospecting — removed from the prospect feed. History below is read-only; reopen from the Ledger.
              </p>
            )}

            {/* A blocked grant used to fall through to "Run Prospect to search for fitting
                non-client orgs" — an invitation to press a button that answers with a 400.
                Naming the real reason is the point: "no ideal applicant profile" and "we
                decided not to pursue this" need different responses from a human, and the
                discovery refusal alone cannot tell them apart. */}
            {blockedReason ? (
              <>
                <p className="mt-3 text-sm text-muted-foreground">
                  Not prospectable — {blockedReason}
                </p>
                {grant.is_domestic && (
                  <p className="mt-2 text-xs text-muted-foreground">
                    {!grant.ideal_applicant_profile && !grant.skip_reason
                      ? "Rebuild the grant profile below to build one — that is exactly what this case needs."
                      : "This gate is re-decided from a fresh read of the NOFO, so it can lift as well as hold — rebuild the grant profile if you disagree with it."}
                  </p>
                )}
              </>
            ) : gate === "not_ready" ? (
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
          {/* Who can apply — the full eligibility facts (eligible entity types incl. a sole type,
              geography, ineligible entities, subaward-prohibited). OverviewCard's eligibility callout is a
              client-oriented VERDICT that under-shows these for a client-less grant view, so the facts stay
              here. */}
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

          {/* Rebuild, here rather than only in the Ledger. Hitting an un-prospectable grant
              and re-shredding it to get a real answer is a PROSPECTING workflow — it is how
              this grant's "single national award" suppression was discovered in the first
              place — and it previously meant leaving Track 2 to do it. Both the page and
              the route are admin-only already, so this opens no new access.

              Domestic only, matching canCalibrate on the Ledger detail: the international
              exclusion is policy, so there is nothing for a re-shred to re-decide. Hidden
              while in flight so it cannot be pressed twice. */}
          {grant.is_domestic && !inFlight && (
            <Card className="p-5">
              <SectionLabel>Calibration</SectionLabel>
              <p className="mt-3 text-xs text-muted-foreground">
                Re-run this grant when the read looks wrong. Rebuilding re-decides the
                prospecting gate from a fresh read of the NOFO, so a suppression can lift as
                well as hold.
              </p>
              <div className="mt-3">
                <RematchButton grantId={grant.id} />
              </div>
            </Card>
          )}
        </aside>
      </div>
    </div>
  );
}
