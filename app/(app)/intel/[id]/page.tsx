import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft, ArrowRight, Puzzle } from "lucide-react";
import { requireAdmin } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { Badge } from "@/components/ui/badge";
import { AutoRefresh } from "@/components/ui/auto-refresh";
import { ScoreBadge, DecisionBadge, GrantStatusBadge } from "@/components/grants/badges";
import { OverviewCard, type ReviewKeyDetail } from "@/components/report/grant-review-console";
import { ProgramAwardMap } from "@/components/report/program-award-map";
import type { ProgramAwardSummary } from "@/lib/grants/program-awards";
import { buildGrantSummary } from "@/lib/report/grant-summary";
import { deadlineDaysLeft } from "@/lib/report/shape";
import { compactCostShare } from "@/lib/grants/format";
import { MatchOutcomes, type OutcomeCard } from "@/components/grants/match-outcomes";
import { getGrantGateStatus, undecidedClientCount } from "@/lib/grants/gate";
import { getSentAlertsByCards } from "@/lib/alerts/sent-status";
import { ProspectButton } from "../prospect-button";
import { CloseProspectingButton } from "../close-prospecting-button";
import { AddToClientControl } from "@/app/(app)/grants/[id]/add-to-client";
import type { Grant, ReviewCard, Client, Prospect, IdealApplicantProfile as IAP } from "@/types/database";

export const dynamic = "force-dynamic";

// The Prospects detail (Track 2) — restyled to MIRROR the grant-report page (facelift). The report's own
// components/layout/tokens are reused near-1:1 with prospecting substitutions:
//   · TOP TILE   → the shared OverviewCard, in its Prospecting variant: who-can-apply chips (WITH ineligible,
//     a staff-decision surface) in place of the eligibility callout; otherwise identical to the report (Key Details panel beside Uses
//     of Funds, the source link, the facts strip). Default OverviewCard is untouched → client report
//     renders byte-identical.
//   · INTELLENGINE SECTION → the report's two-column [narrative | fit-factors] shell, substituted here for
//     [ Ideal-application narrative | Program Award History map (the SAME component the report uses) ].
//   · RIGHT RAIL (the report's ScoreCard slot) → a navy action box (Prospect + Add-to-client), then the
//     client-match summary (who among our clients matched + the conflict gate) below it.
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
  // summary = description_brief || description — EXACTLY what the report tile shows (roadmap/[cardId]:391), so
  // the pre-summarised brief (not the raw full NOFO text) rides the truncating ProgrammeSummary; the
  // authoritative full text stays one click away via the "View posting" source link the Key Details panel
  // renders. whoCanApply replaces the eligibility callout with who-can-apply chips (WITH ineligible — a
  // staff-decision surface, unlike the client report).
  const summaryProps = buildGrantSummary(grant);
  const whoCanApply = {
    types: (grant.eligible_entity_types ?? []).map((t) => t.replace(/_/g, " ")),
    // Prospecting is a STAFF decision surface — surface who is explicitly DISQUALIFIED too (Shannon,
    // reversing the earlier client-report-style drop), so staff see it before reaching out to an org. This
    // stays Prospecting-only: the client report/Ledger pass no whoCanApply and keep the EligibilityCallout.
    ineligible: grant.ineligible_entities,
    geography: grant.geographic_eligibility ?? null,
    subawardProhibited: !!grant.subaward_prohibited,
  };
  // Key Details panel — rebuilt EXACTLY as the report's OverviewCard does (roadmap/[cardId]:305), so the
  // panel rides to the right of Uses of Funds and carries the "View official posting" link (rendered inside
  // KeyDetailsList when sourceUrl is passed).
  const days = deadlineDaysLeft(grant.submission_deadline);
  const keyDetails: ReviewKeyDetail[] = [
    { label: "Opportunity number", value: grant.fon?.trim() || "—" },
    { label: "CFDA", value: (grant.assistance_listings ?? []).map((a) => a.number).join(", ") || "—" },
    { label: "Cost sharing", value: compactCostShare(grant.cost_share) },
  ];
  if (days !== null) {
    keyDetails.push(
      days > 0
        ? { label: "Days remaining", value: String(days) }
        : days === 0
          ? { label: "Days remaining", value: "Closes today" }
          : { label: "Closed", value: `${Math.abs(days)} ${Math.abs(days) === 1 ? "day" : "days"} ago` },
    );
  }
  // Guard the ingest "manual-paste" sentinel: a raw-text paste stores source_url="manual-paste"
  // (app/api/grants/ingest), which is truthy and would render a broken href. Match the guard the other
  // source-link call sites use (grant-detail.tsx:271 et al.); the shared KeyDetailsList doesn't filter it,
  // so filter here at the call site. Manual pastes are common on /intel, so this really bites.
  const postingUrl = grant.source_url && grant.source_url !== "manual-paste" ? grant.source_url : null;

  // Rail action gating (moved OUT of the tile into the navy rail box). Prospecting is hidden once the grant
  // is closed for it / blocked / unscored (the button used to live inside the Prospects card's
  // `!prospecting_closed_at` branch — the guard moves with it; `gate="not_ready"` already covers in-flight).
  // Add-to-client is domestic-only (the server hard-rejects an international add with a non-overridable 400)
  // AND hidden while the grant is mid-shred/rematch (`!inFlight`): adding a client against mid-flip facts
  // writes a permanent card the fresh shred won't correct. Both mirror the Ledger's `canCalibrate = admin
  // && is_domestic` + `!processing` gate.
  const canProspect = gate !== "not_ready" && !blockedReason && !grant.prospecting_closed_at;
  const canAdd = !!grant.is_domestic && !inFlight;
  // One-line "can't prospect yet" hint restoring the guidance the removed Prospects tile carried (JUST the
  // line — not the old empty-state box). Rendered in the action box's Prospect slot when prospecting is off
  // but the well is still showing (an Add control / prospect history). Null when prospecting is available, or
  // when the grant is closed (the prospects table's "Closed" badge already says so).
  const prospectHint =
    canProspect || grant.prospecting_closed_at
      ? null
      : !grant.ideal_applicant_profile
        ? "Profile incomplete — rebuild from the Ledger to enable prospecting."
        : gate === "not_ready"
          ? "Not scored yet — prospecting unlocks once it's evaluated against the roster."
          : blockedLabel;

  // ── INTELLENGINE section: left column — the ideal-application narrative (slimmed to applicant + note). ──
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
        {/* The authoritative posting link now rides the OverviewCard Key Details panel (as on the report);
            the context bar keeps the Ledger link the "rebuild the profile" copy below refers to (a dead-end
            instruction without it). */}
        <Link
          href={`/grants/${grant.id}`}
          className="ml-auto inline-flex items-center gap-[5px] rounded-sharp text-[12.5px] font-medium text-ink-muted transition-colors hover:text-brand-navy"
        >
          Open Shred
          <ArrowRight className="h-3.5 w-3.5" aria-hidden="true" />
        </Link>
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
            {/* TOP TILE — shared OverviewCard, Prospecting variant. Key Details panel + source link restored
                exactly as the report renders them; actions moved to the rail box (see below). */}
            <OverviewCard
              {...summaryProps}
              summary={grant.description_brief || grant.description}
              keyDetails={keyDetails}
              sourceUrl={postingUrl}
              whoCanApply={whoCanApply}
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
                  Ideal application · award history
                </span>
              </div>
              <div className="grid gap-6 px-5 py-[18px] lg:grid-cols-[1.3fr_1.65fr]">
                {/* LEFT — the ideal-application narrative (slimmed): the intro spiel, then Ideal applicant
                    (core funded role + archetype prime shapes) with the eligibility note directly under it.
                    Co-applicants (partner_seats) and the scope placeholder are intentionally NOT rendered on
                    this surface — the underlying fields stay in the data (IdealApplicantProfile type + engine
                    unchanged), just not shown here. */}
                <div className="min-w-0">
                  <p className={EYEBROW}>Ideal application</p>
                  {iap?.summary ? (
                    <p className="mt-2 text-[13px] leading-[1.65] text-ink-muted [text-wrap:pretty]">{iap.summary}</p>
                  ) : (
                    <p className="mt-2 text-[13px] leading-[1.6] text-ink-subtle">
                      No ideal-applicant profile was built for this grant yet — run a re-shred from the Ledger
                      to build one.
                    </p>
                  )}

                  {iap && (
                    <div className="mt-4 space-y-4">
                      {/* Ideal applicant — the ideal PRIME. */}
                      <div>
                        <p className="text-[11px] font-bold uppercase tracking-[0.09em] text-brand-navy">
                          Ideal applicant
                        </p>
                        {iap.core_funded_role && (
                          <p className="mt-1.5 text-[12.5px] leading-[1.55] text-ink-muted">
                            <span className="font-semibold text-brand-navy">Core funded role: </span>
                            {iap.core_funded_role}
                          </p>
                        )}
                        {iapArchetypes.length > 0 ? (
                          <div className="mt-1.5 space-y-1.5">
                            {iapArchetypes.map((a, i) => (
                              <p key={i} className="text-[12.5px] leading-[1.55] text-ink-muted">
                                <span className="font-semibold text-brand-navy">{a.label}</span>
                                {a.ideal_prime_shape ? ` — ${a.ideal_prime_shape}` : ""}
                              </p>
                            ))}
                          </div>
                        ) : (
                          !iap.core_funded_role && (
                            <p className="mt-1.5 text-[12px] leading-[1.5] text-ink-subtle">
                              No prime shape specified.
                            </p>
                          )
                        )}
                      </div>

                      {/* The eligibility note rides directly under Ideal applicant. */}
                      {iap.eligibility_note && (
                        <p className="text-[11.5px] leading-[1.5] text-ink-subtle">{iap.eligibility_note}</p>
                      )}
                    </div>
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
          </div>

          {/* RAIL — top: the navy action box (the report's ScoreCard slot), then the client-match summary. */}
          <aside className="flex min-w-0 flex-col gap-[18px]">
            {/* NAVY ACTION BOX ("IntellEngine Action") — Prospect + Add-to-client (moved out of the top tile),
                each under a small caption, plus the discovered-prospects table below them (relocated from the
                old full-width Prospects tile). Navy chrome (BRAND token) with a white action well so the
                default-navy buttons stay legible; both controls carry text labels + a caption. */}
            <section className="rounded-sharp bg-brand-navy p-4 shadow-sm">
              <p className="text-[10px] font-bold uppercase tracking-[0.11em] text-white/75">IntellEngine Action</p>
              {canProspect || canAdd || prospectCards.length > 0 ? (
                <div className="mt-3 space-y-3.5 rounded-sharp bg-white p-3.5">
                  {canProspect ? (
                    <div>
                      <p className="mb-1.5 text-[11.5px] text-ink-subtle">Prospect to a non-client</p>
                      <ProspectButton grantId={grant.id} />
                    </div>
                  ) : (
                    prospectHint && (
                      <p className="text-[11.5px] leading-[1.5] text-ink-subtle">{prospectHint}</p>
                    )
                  )}
                  {canAdd && (
                    <div>
                      <p className="mb-1.5 text-[11.5px] text-ink-subtle">Add to an existing client</p>
                      <AddToClientControl grantId={grant.id} clients={activeClients} />
                    </div>
                  )}
                  {/* Discovered prospects — compact, scrollable; only rendered when some exist (no empty state).
                      Same data as the old Prospects tile; CloseProspectingButton rides the header here now. */}
                  {prospectCards.length > 0 && (
                    <div className={canProspect || canAdd ? "border-t border-hairline-strong pt-3" : ""}>
                      <div className="flex items-center justify-between gap-2">
                        <p className="text-[11.5px] text-ink-subtle">Prospects ({prospectCards.length})</p>
                        {grant.prospecting_closed_at ? (
                          <Badge variant="warning">Closed</Badge>
                        ) : (
                          <CloseProspectingButton grantId={grant.id} />
                        )}
                      </div>
                      <ul className="mt-2 max-h-[220px] divide-y divide-brand-navy/[0.08] overflow-y-auto text-[13px]">
                        {prospectCards.map((pc) => (
                          <li key={pc.id} className="flex items-center justify-between gap-2 py-2">
                            <Link
                              href={`/review/${pc.id}`}
                              className="min-w-0 truncate font-medium text-brand-navy hover:underline"
                            >
                              {pc.prospects?.name || "Prospect org"}
                            </Link>
                            <div className="flex shrink-0 items-center gap-1.5">
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
                    </div>
                  )}
                </div>
              ) : (
                <p className="mt-2 text-[12.5px] leading-[1.5] text-white/80">
                  {/* A permanent block (blockedLabel) wins; else an in-flight grant is only TEMPORARILY
                      unavailable (AutoRefresh unlocks it), so say so rather than a bare "not available" that
                      reads as a permanent dead-end — mirrors the client-match box's not_ready copy. */}
                  {blockedLabel
                    ? `${blockedLabel} — not available for prospecting or client-matching.`
                    : inFlight
                      ? "Still shredding / rematching — this unlocks once it finishes."
                      : "Not available for prospecting or client-matching."}
                </p>
              )}
            </section>

            <section className="rounded-sharp border border-edge bg-white p-5">
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
            </section>
          </aside>
        </div>
      </div>
    </div>
  );
}
