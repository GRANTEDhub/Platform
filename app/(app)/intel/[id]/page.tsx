import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft, Puzzle } from "lucide-react";
import { requireAdmin } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { AutoRefresh } from "@/components/ui/auto-refresh";
import { ScoreBadge, DecisionBadge, GrantStatusBadge } from "@/components/grants/badges";
import { OverviewCard } from "@/components/report/grant-review-console";
import { ProgramAwardMap } from "@/components/report/program-award-map";
import type { ProgramAwardSummary } from "@/lib/grants/program-awards";
import { buildGrantSummary } from "@/lib/report/grant-summary";
import { MatchOutcomes, type OutcomeCard } from "@/components/grants/match-outcomes";
import { getGrantGateStatus, undecidedClientCount } from "@/lib/grants/gate";
import { getSentAlertsByCards } from "@/lib/alerts/sent-status";
import { ProspectButton } from "../prospect-button";
import { CloseProspectingButton } from "../close-prospecting-button";
import { AddToClientControl } from "@/app/(app)/grants/[id]/add-to-client";
import type { Grant, ReviewCard, Client, Prospect, IdealApplicantProfile as IAP } from "@/types/database";

export const dynamic = "force-dynamic";

// The Prospects detail (Track 2) — restyled to MIRROR the grant-report page (facelift v2). The report's
// own components/layout/tokens are reused near-1:1 with prospecting substitutions:
//   · TOP TILE   → the shared OverviewCard, in its Prospecting variant: who-can-apply chips (no ineligible)
//     in place of the eligibility callout, and the Prospect + Add-to-client controls in the top-right in
//     place of a fit score. Default OverviewCard is untouched, so the client report renders byte-identical.
//   · INTELLENGINE SECTION → the report's two-column [narrative | fit-factors] shell, substituted here for
//     [ condensed ideal-applicant spiel | Program Award History map (the SAME component the report uses) ].
//   · CLIENT-MATCH SUMMARY → the report's "IntellEngine box" slot (the rail), rendering who among our
//     clients matched + the conflict gate.
//   · The discovered prospect orgs — prospecting's core output, no report analog — sit in a full-width
//     "Prospects" section below the IntellEngine section.
// Make-or-break + risk factors are dropped (not in this layout).
const EYEBROW = "text-[10px] font-bold uppercase tracking-[0.11em] text-ink-muted";

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

  // Derive the "Alerted" state from grant_alerts (one batched query for all prospect cards).
  const sentByCard = await getSentAlertsByCards(prospectCards.map((c) => c.id));

  const gate = getGrantGateStatus(grant, all);
  const undecided = undecidedClientCount(all);
  // A client actively pursuing this grant is the one case worth a loud warning before reaching out to an
  // outside org (potential conflict). Prospecting is otherwise never held by client decisions.
  const pursuing = clientCards.filter((c) => c.decision === "approved").length;

  // Active clients for the Add-to-client control (same load the Ledger detail does for it). Admin-only page.
  const { data: clientRows } = await supabase
    .from("clients")
    .select("id, name")
    .eq("status", "active")
    .order("name");
  const activeClients = (clientRows ?? []) as { id: string; name: string }[];

  // Why this grant cannot be prospected, or null when it can. Mirrors getProspectFeed's own exclusions
  // (gate.ts) — the FEED filters these out, so you only land here from a stale tab / bookmark / the back
  // button after a re-shred changed the answer. International (policy) outranks the suppression heuristic.
  const blockedReason: string | null = !grant.is_domestic
    ? "International — excluded by GRANTED's domestic-only policy."
    : (grant.hard_disqualifiers?.length ?? 0) > 0
      ? grant.hard_disqualifiers!.join("; ")
      : grant.skip_reason
        ? grant.skip_reason
        : !grant.ideal_applicant_profile
          ? "No ideal-applicant profile was built for this grant, so there are no seats to match candidate orgs against."
          : null;

  // The SHORT badge label for the blocked state — names the case (the "no profile" one is the only one a
  // rebuild fixes) instead of burying it in a sentence. Same precedence as blockedReason.
  const blockedLabel: string | null = !grant.is_domestic
    ? "International — excluded"
    : (grant.hard_disqualifiers?.length ?? 0) > 0
      ? "Disqualified — can't prospect"
      : grant.skip_reason
        ? "Suppressed — not pursued"
        : !grant.ideal_applicant_profile
          ? "No profile — can't prospect"
          : null;

  // In flight — the same three non-terminal statuses the Ledger treats as processing.
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

  // ── TOP TILE props — the shared OverviewCard in its Prospecting variant. ──
  // summary = the full description (the report shows it in the tile's ProgrammeSummary, truncated); the old
  // staff layout's separate "What it funds" card is gone in the report-mirror. whoCanApply replaces the
  // eligibility callout with who-can-apply chips (no ineligible). actions puts the two controls top-right.
  const summaryProps = buildGrantSummary(grant);
  const whoCanApply = {
    types: (grant.eligible_entity_types ?? []).map((t) => t.replace(/_/g, " ")),
    geography: grant.geographic_eligibility ?? null,
    subawardProhibited: !!grant.subaward_prohibited,
  };
  const topActions = (
    <>
      {gate !== "not_ready" && !blockedReason && <ProspectButton grantId={grant.id} />}
      <AddToClientControl grantId={grant.id} clients={activeClients} />
    </>
  );

  // ── INTELLENGINE section: left column — the condensed ideal-applicant spiel. ──
  const iap = grant.ideal_applicant_profile as IAP | null | undefined;
  const iapArchetypes = iap?.archetypes ?? [];

  // ── Program award map (right column). Reuse the report's component + its exact data source, untouched. ──
  const hasCfda = Array.isArray(grant.assistance_listings) && grant.assistance_listings.length > 0;
  const programAwardSummary = (grant.program_award_summary as unknown as ProgramAwardSummary | null) ?? null;

  return (
    <div className="min-h-full bg-ground">
      {/* Live-refresh while the grant is still shredding / scoring, matching the Ledger detail. */}
      <AutoRefresh enabled={inFlight} />

      {/* Context bar — mirrors the report's top bar chrome (no client context here; back-nav + grant status
          badges instead of a client monogram). */}
      <div className="flex flex-wrap items-center gap-x-5 gap-y-2 border-b border-hairline-strong bg-white px-[30px] py-3">
        <Link
          href="/intel/grants"
          className="inline-flex shrink-0 items-center gap-[7px] rounded-sharp text-[12.5px] font-medium text-ink-muted transition-colors hover:text-brand-navy"
        >
          <ArrowLeft className="h-3.5 w-3.5" aria-hidden="true" />
          Grant prospecting
        </Link>
        <span aria-hidden="true" className="h-[18px] w-px shrink-0 bg-brand-navy/[0.12]" />
        <div className="flex flex-wrap items-center gap-2">
          {!grant.is_domestic && <Badge variant="warning">International — excluded</Badge>}
          <Badge variant={grant.shred_depth === "full" ? "success" : "warning"}>
            {grant.shred_depth === "full" ? "Full shred" : "Summary shred"}
          </Badge>
          <GrantStatusBadge status={grant.status} grantStatus={grant.grant_status} />
        </div>
      </div>

      <div className="px-[30px] pb-6 pt-[18px]">
        {grant.grant_status === "Forecasted" ? (
          <p className="mb-3 text-sm text-muted-foreground">Forecasted — no NOFO published yet.</p>
        ) : grant.shred_depth === "summary" && grant.shred_reason ? (
          <p className="mb-3 text-xs text-muted-foreground">Summary shred only — {grant.shred_reason}</p>
        ) : null}

        {/* Report frame: main (1fr) + 386px rail. Natural flow (not the report's zero-scroll frame) — the
            prospecting content is variable-height, so a hard overflow-hidden frame would clip it. */}
        <div className="grid gap-[18px] xl:grid-cols-[1fr_386px] xl:items-start">
          <div className="flex min-w-0 flex-col gap-[18px]">
            {/* TOP TILE — shared OverviewCard, Prospecting variant. */}
            <OverviewCard
              {...summaryProps}
              summary={grant.description}
              whoCanApply={whoCanApply}
              actions={topActions}
            />

            {/* INTELLENGINE SECTION — the report's two-column shell, substituted [ ideal-applicant spiel |
                Program Award History map ]. */}
            <section className="rounded-sharp border border-edge bg-white">
              <div className="flex items-center gap-3 border-b border-hairline-strong px-5 pb-3 pt-[14px]">
                <span className="flex h-[30px] w-[30px] shrink-0 items-center justify-center rounded-full bg-brand-navy/[0.06]">
                  <Puzzle className="h-4 w-4 text-brand-navy" aria-hidden="true" />
                </span>
                <h2 className="font-serif text-[17px] font-bold text-brand-navy">IntellEngine</h2>
                <span className="ml-auto rounded-full bg-brand-navy/[0.06] px-3 py-1 text-[11px] font-semibold text-brand-navy">
                  Ideal applicant · award history
                </span>
              </div>
              <div className="grid gap-6 px-5 py-[18px] lg:grid-cols-[1.3fr_1.65fr]">
                {/* LEFT — condensed ideal-applicant spiel. */}
                <div className="min-w-0">
                  <p className={EYEBROW}>Ideal applicant</p>
                  {iap?.summary ? (
                    <p className="mt-2 text-[13px] leading-[1.65] text-ink-muted [text-wrap:pretty]">{iap.summary}</p>
                  ) : (
                    <p className="mt-2 text-[13px] leading-[1.6] text-ink-subtle">
                      No ideal-applicant profile was built for this grant yet — run a re-shred from the Ledger
                      to build one.
                    </p>
                  )}
                  {iap?.core_funded_role && (
                    <p className="mt-2.5 text-[12.5px] leading-[1.55] text-ink-muted">
                      <span className="font-semibold text-brand-navy">Core funded role: </span>
                      {iap.core_funded_role}
                    </p>
                  )}
                  {iapArchetypes.length > 0 && (
                    <div className="mt-3 space-y-2">
                      {iapArchetypes.map((a, i) => (
                        <p key={i} className="text-[12.5px] leading-[1.55] text-ink-muted">
                          <span className="font-semibold text-brand-navy">{a.label}</span>
                          {a.ideal_prime_shape ? ` — prime: ${a.ideal_prime_shape}` : ""}
                          {(a.partner_seats?.length ?? 0) > 0 ? ` · partners: ${a.partner_seats.join(", ")}` : ""}
                        </p>
                      ))}
                    </div>
                  )}
                  {iap?.eligibility_note && (
                    <p className="mt-3 text-[11.5px] leading-[1.5] text-ink-subtle">{iap.eligibility_note}</p>
                  )}
                </div>

                {/* RIGHT — Program Award History map, the SAME component the report uses (reused as-is). */}
                <div className="min-w-0">
                  {hasCfda ? (
                    <ProgramAwardMap compact grantId={grant.id} initialSummary={programAwardSummary} hasCfda />
                  ) : (
                    <div className="flex h-full min-h-[140px] items-center justify-center rounded-sharp border border-edge bg-brand-cream/40 px-4 py-6 text-center text-[12px] text-ink-subtle">
                      No CFDA on this grant — no program award history to map.
                    </div>
                  )}
                </div>
              </div>
            </section>

            {/* PROSPECTS — the discovered non-client orgs + the Prospect action's output. Prospecting's core
                output; no report analog, so it sits full-width below the IntellEngine section. */}
            <section className="rounded-sharp border border-edge bg-white px-5 py-[18px]">
              <div className="flex items-center justify-between gap-3">
                <p className={EYEBROW}>Prospects ({prospectCards.length})</p>
                {grant.prospecting_closed_at ? (
                  <Badge variant="warning">Closed for prospecting</Badge>
                ) : (
                  <CloseProspectingButton grantId={grant.id} />
                )}
              </div>

              {grant.prospecting_closed_at && (
                <p className="mt-3 text-sm text-muted-foreground">
                  Closed for prospecting — removed from the prospect feed. History below is read-only; reopen from the Ledger.
                </p>
              )}

              {blockedReason ? (
                <>
                  <div className="mt-3 flex items-start gap-2.5">
                    {blockedLabel && <Badge variant="warning" className="shrink-0">{blockedLabel}</Badge>}
                    <p className="text-sm text-muted-foreground">{blockedReason}</p>
                  </div>
                  {grant.is_domestic && (
                    <p className="mt-2 text-xs text-muted-foreground">
                      {!grant.ideal_applicant_profile && !grant.skip_reason
                        ? "Rebuild the grant profile from the Ledger to build one — that is exactly what this case needs."
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
                  No prospects surfaced yet. Use the Prospect button (top right) to search for fitting non-client orgs.
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
            </section>
          </div>

          {/* RAIL — the report's "IntellEngine box" slot: the client-match summary (status verdict + who
              matched). */}
          <aside className="flex min-w-0 flex-col gap-[18px]">
            <Card className="p-5">
              <p className={EYEBROW}>Client match</p>
              <div className="mt-3 flex items-start gap-2.5 text-sm text-muted-foreground">
                {gate === "not_ready" ? (
                  <p>Not scored yet — can&apos;t prospect until it&apos;s evaluated against the roster.</p>
                ) : pursuing > 0 ? (
                  <>
                    <Badge variant="warning" className="shrink-0">Client pursuing</Badge>
                    <span>
                      {pursuing} client {pursuing === 1 ? "is" : "are"} actively pursuing this — reaching out to
                      an outside org may conflict. See the matches below.
                    </span>
                  </>
                ) : clientCards.length > 0 ? (
                  <>
                    <Badge variant="secondary" className="shrink-0">Matched</Badge>
                    <span>
                      Matched to {clientCards.length} client{clientCards.length === 1 ? "" : "s"}
                      {undecided > 0 ? ", some still deciding" : ", all decided"}. Not held — free to prospect.
                    </span>
                  </>
                ) : (
                  <>
                    <Badge variant="accent" className="shrink-0">Open</Badge>
                    <span>No client match — open to prospect.</span>
                  </>
                )}
              </div>
              <div className="mt-4 border-t border-hairline-strong pt-4">
                <MatchOutcomes cards={carryOver} emptyText="No client matches on this grant." />
              </div>
            </Card>
          </aside>
        </div>
      </div>
    </div>
  );
}
