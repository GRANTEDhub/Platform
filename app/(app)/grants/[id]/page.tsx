import { notFound } from "next/navigation";
import { format, parseISO } from "date-fns";
import { requireUser } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { PageHeader } from "@/components/layout/page-header";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { GrantStatusBadge } from "@/components/grants/badges";
import { GrantOverview, GrantKeyFacts } from "@/components/grants/grant-facts";
import { MatchOutcomes, type OutcomeCard } from "@/components/grants/match-outcomes";
import { ConsortiumPairings } from "@/components/grants/consortium-pairings";
import { computeConsortiumPairings, type SeatedClient } from "@/lib/grants/consortium";
import { getGrantDisposition } from "@/lib/grants/disposition";
import { AutoRefresh } from "@/components/ui/auto-refresh";
import { RematchButton } from "./rematch-button";
import { AddToClientControl } from "./add-to-client";
import type { Grant, ReviewCard, Client } from "@/types/database";

export const dynamic = "force-dynamic";

// The Ledger detail: a READ-ONLY record of a grant and its outcome. Grant facts,
// plus who-it-matched-to and the result (inline, no link into the decision
// surface). Re-match / re-shred live here -- off the daily Matches/Prospects
// path -- as the calibration / "I disagree, re-run it" tools. The prospect-facing
// view is a separate route (/intel/[id]); this page never routes into it.
type CardWithClient = ReviewCard & { clients: Pick<Client, "id" | "name" | "org_type"> | null };

export default async function LedgerDetailPage({ params }: { params: { id: string } }) {
  const profile = await requireUser();
  const supabase = createClient();

  const { data: grant } = await supabase
    .from("grants")
    .select("*")
    .eq("id", params.id)
    .single<Grant>();

  if (!grant) notFound();

  const { data: cards } = await supabase
    .from("review_cards")
    .select("*, clients(id, name, org_type)")
    .eq("grant_id", params.id)
    .order("fit_score", { ascending: false })
    // Generic-over-specific demote: an inferred-nexus card sinks within its fit tier. Inert while
    // every row is false (flag OFF).
    .order("generic_nexus_flagged", { ascending: true });

  // Client cards only -- prospect cards belong to the Prospects surface.
  const clientCards = ((cards ?? []) as CardWithClient[]).filter(
    (c) => c.card_type !== "prospect",
  );
  const outcomes: OutcomeCard[] = clientCards.map((c) => ({
    id: c.id,
    name: c.clients?.name ?? null,
    decision: c.decision,
    sent_at: c.sent_at,
    proposed_role: c.proposed_role,
    recommended_prime: c.recommended_prime,
    // Gates the per-card re-match control (canRematch below): a released card is not
    // re-scored from here.
    sme_released_at: c.sme_released_at,
  }));
  // In-flight = not yet terminal. Move 2's matching queue adds 'queued' (waiting
  // for the drain) and 'matching' (drain is scoring it) alongside the original
  // 'processing' (shredding). All three must auto-refresh, suppress the
  // "no match" empty state, and hide calibration -- so they share this flag.
  const processing =
    grant.status === "processing" ||
    grant.status === "queued" ||
    grant.status === "matching";
  // Forecasted opportunities have no NOFO yet, so summary-shred / failed copy is
  // misleading -- forecasted takes precedence over both.
  const forecasted = grant.grant_status === "Forecasted";

  // Incomplete-scoring visibility. match_attempts is append-only, so reduce to
  // each client's LATEST attempt and count those whose newest outcome errored.
  // result carries the engine's seat_ref (not stored on the card) -- used for the
  // consortium pairing detection below.
  const { data: attempts } = await supabase
    .from("match_attempts")
    .select("client_id, outcome, created_at, result")
    .eq("grant_id", params.id);

  const latestByClient = new Map<
    string,
    { outcome: string; created_at: string; result: unknown }
  >();
  for (const a of attempts ?? []) {
    if (!a.client_id) continue;
    const prev = latestByClient.get(a.client_id);
    if (!prev || a.created_at > prev.created_at) {
      latestByClient.set(a.client_id, {
        outcome: a.outcome,
        created_at: a.created_at,
        result: a.result,
      });
    }
  }
  const erroredClientCount = [...latestByClient.values()].filter(
    (a) => a.outcome === "error",
  ).length;

  // Consortium pairings (Feature A): join each still-live client card (not
  // passed) to its latest attempt's seat_ref, then detect complementary
  // prime+supporting occupancy under the same archetype. Pure read-time surfacing
  // over existing matcher output -- no scoring.
  const seatedClients: SeatedClient[] = clientCards
    .filter((c) => c.decision !== "passed" && c.client_id)
    .map((c) => ({
      clientId: c.client_id!,
      clientName: c.clients?.name ?? null,
      fitScore: c.fit_score,
      proposedRole: c.proposed_role,
      seatRef:
        (latestByClient.get(c.client_id!)?.result as { seat_ref?: string } | undefined)?.seat_ref ??
        "",
    }));
  const consortiumPairings = computeConsortiumPairings(
    seatedClients,
    grant.ideal_applicant_profile,
  );

  // THE SAME DISPOSITION THE LEDGER LIST SHOWS. This page used to re-derive its own
  // answer to "what happened to this grant", and got the one case wrong that matters
  // most: a grant-level suppression (skip_reason) has no ideal_applicant_profile
  // BECAUSE STAGE A IS SKIPPED BY DESIGN, so a bare `full shred && no profile` test
  // reads it as a Stage-A failure and tells you to rebuild. Rebuilding is a no-op that
  // costs a NOFO re-fetch plus an extraction call every press.
  //
  // getGrantDisposition already checks skip_reason BEFORE the profile-gap branch,
  // deliberately, for exactly this reason. Asking it instead of re-deriving is what
  // stops the two surfaces disagreeing — and it is why the banner below is gated on the
  // TIER, not on a condition of its own.
  //
  // has_ideal_profile is passed rather than Picked because the shared helper supports a
  // lightweight `is not null` query; this page already selects `*`, so it is free here.
  const disposition = getGrantDisposition(
    { ...grant, has_ideal_profile: !!grant.ideal_applicant_profile },
    clientCards.map((c) => ({
      card_type: c.card_type,
      decision: c.decision,
      org_name: c.clients?.name ?? null,
    })),
  );

  const canCalibrate = profile.role === "admin" && grant.is_domestic;

  // ONE RematchButton on the page, and this is the precedence that decides whose.
  // Three banners plus the Calibration card could each render one — Shannon hit two on
  // screen at once, with the same helper text under both.
  //
  // The control belongs beside the message that explains it, so the disposition banner
  // wins when there is one; the incomplete-scoring banner takes it next; Calibration's
  // general "re-run after a roster change" copy yields to both. Derived here rather than
  // inline so the three render sites cannot drift back apart.
  const dispositionBanner =
    !processing && (disposition.tier === "profile_gap" || disposition.tier === "not_pursued");
  // Named for what it decides: whether the incomplete-scoring banner OWNS the control.
  // That banner's message always renders when scoring errored — only the duplicate button
  // drops when a disposition banner above is already carrying one.
  const erroredBannerOwnsRematch = erroredClientCount > 0 && !processing && !dispositionBanner;
  const bannerOffersRematch = canCalibrate && (dispositionBanner || erroredBannerOwnsRematch);

  // Active clients for the manual "Add to Client" control (admin calibration only).
  let activeClients: { id: string; name: string }[] = [];
  if (canCalibrate) {
    const { data: clientRows } = await supabase
      .from("clients")
      .select("id, name")
      .eq("status", "active")
      .order("name");
    activeClients = (clientRows ?? []) as { id: string; name: string }[];
  }

  return (
    <div>
      <AutoRefresh enabled={processing} />
      <PageHeader
        backHref="/grants"
        backLabel="Ledger"
        title={grant.title || "Processing opportunity…"}
        description={[grant.funder, grant.fon].filter(Boolean).join(" · ") || undefined}
        action={
          <div className="flex items-center gap-2">
            {grant.activated_from_forecast_at && (
              <Badge variant="secondary">
                Was forecasted, now active · {format(parseISO(grant.activated_from_forecast_at), "MMM d, yyyy")}
              </Badge>
            )}
            {!grant.is_domestic && <Badge variant="warning">International — excluded</Badge>}
            {!processing && !forecasted && (
              <Badge variant={grant.shred_depth === "full" ? "success" : "warning"}>
                {grant.shred_depth === "full" ? "Full shred" : "Summary shred"}
              </Badge>
            )}
            <GrantStatusBadge status={grant.status} grantStatus={grant.grant_status} />
          </div>
        }
      />

      <div className="grid gap-6 p-8 lg:grid-cols-3">
        <div className="space-y-6 lg:col-span-2">
          {processing && (
            <Card>
              <CardContent className="p-6 text-sm text-muted-foreground">
                {grant.status === "queued"
                  ? "Queued for matching — the drain will pick this up shortly. This page refreshes automatically."
                  : grant.status === "matching"
                    ? "Scoring against the client roster… this page refreshes automatically."
                    : "Shredding the NOFO and scoring it against the client roster… this page refreshes automatically."}
              </CardContent>
            </Card>
          )}

          {forecasted && !processing && (
            <Card>
              <CardContent className="p-6 text-sm text-muted-foreground">
                <p className="font-medium text-foreground">Forecasted — no NOFO published yet.</p>
                <p className="mt-1">
                  This opportunity was found in a forecast search. Full analysis runs once it is
                  posted and re-shredded.
                </p>
              </CardContent>
            </Card>
          )}

          {grant.status === "error" && !forecasted && (
            <Card>
              <CardContent className="space-y-2 p-6 text-sm">
                <p className="font-medium text-destructive">Analysis failed</p>
                {grant.error_detail ? (
                  <p className="whitespace-pre-wrap font-mono text-xs text-muted-foreground">
                    {grant.error_detail}
                  </p>
                ) : (
                  <p className="text-muted-foreground">
                    Something went wrong analyzing this opportunity. Check the source link and try again.
                  </p>
                )}
              </CardContent>
            </Card>
          )}

          {/* Gated on the shared disposition TIER, never on a local condition — see the
              note beside the getGrantDisposition call. A suppressed or hard-disqualified
              grant lands in `not_pursued` and renders the panel below instead, which is
              the whole point: this banner claims Stage A failed and offers a retry, and
              both are false for a grant we chose not to profile. */}
          {!processing && disposition.tier === "profile_gap" && (
            <div className="rounded-lg border border-amber-300 bg-amber-50 p-4">
              <p className="text-sm font-medium text-amber-900">
                Profile not built — this grant can&apos;t match
              </p>
              {/* The label carries the sub-cause (Stage-A failure vs. unreachable NOFO) and
                  the ACTION, and the detail carries the recorded error or shred reason. Both
                  come from the helper so the Ledger row and this page cannot disagree about
                  what went wrong or what to do about it. */}
              <p className="mt-1 text-sm text-amber-800">{disposition.label}</p>
              {disposition.detail && (
                <p className="mt-2 whitespace-pre-wrap font-mono text-xs text-amber-900/80">
                  {disposition.detail}
                </p>
              )}
              {canCalibrate && (
                <div className="mt-3">
                  <RematchButton grantId={grant.id} />
                </div>
              )}
            </div>
          )}

          {/* Not pursued: international, hard-disqualified, or grant-level suppressed. The
              engine never scored the roster here, so this panel exists to say so — without
              it the "Matched clients (0)" card below is the only signal and it reads as a
              scan that found nobody. The rebuild is offered because a suppression is a
              HEURISTIC a fresh shred can revise in either direction: this grant's
              skip_reason only appeared on its second shred, and a third could clear it. */}
          {!processing && disposition.tier === "not_pursued" && (
            <div className="rounded-lg border border-amber-300 bg-amber-50 p-4">
              <p className="text-sm font-medium text-amber-900">
                Not pursued — the roster was never scored against this grant
              </p>
              {disposition.detail && <p className="mt-1 text-sm text-amber-800">{disposition.detail}</p>}
              {/* canCalibrate already requires is_domestic, so an international grant
                  offers no rebuild — that exclusion is policy and not re-decidable. */}
              {canCalibrate && (
                <>
                  <p className="mt-2 text-xs text-amber-900/80">
                    If you disagree, rebuild the grant profile — the gate is re-decided from a
                    fresh read of the NOFO, so it can lift as well as hold.
                  </p>
                  <div className="mt-3">
                    <RematchButton grantId={grant.id} />
                  </div>
                </>
              )}
            </div>
          )}

          <GrantOverview grant={grant} />

          {erroredClientCount > 0 && !processing && (
            <div className="rounded-lg border border-amber-300 bg-amber-50 p-4">
              <p className="text-sm font-medium text-amber-900">Scoring was incomplete</p>
              <p className="mt-1 text-sm text-amber-800">
                {erroredClientCount} client{erroredClientCount === 1 ? "" : "s"} couldn&apos;t be
                scored on the last run — likely a transient API error — so{" "}
                {erroredClientCount === 1 ? "it is" : "they are"} missing from the record below.
                Re-match to retry.
              </p>
              {/* Yields to a disposition banner above — see the precedence note. The
                  message still renders either way; only the duplicate control drops. */}
              {canCalibrate && erroredBannerOwnsRematch && (
                <div className="mt-3">
                  <RematchButton grantId={grant.id} />
                </div>
              )}
            </div>
          )}

          <Card>
            <CardHeader><CardTitle>Matched clients ({outcomes.length})</CardTitle></CardHeader>
            <CardContent>
              <MatchOutcomes
                cards={outcomes}
                // Admin calibration only (same gate as Re-match / Add-to-client): a per-card
                // re-match on each still-pending row. Off for everyone else -> read-only list.
                canRematch={canCalibrate}
                emptyText={
                  processing
                    ? "Scoring in progress…"
                    : !grant.is_domestic
                      ? "International opportunity — excluded from matching by policy."
                      : erroredClientCount > 0
                        ? "Scoring was incomplete — see the notice above. Re-match to retry before treating this as a no-match."
                        // NOT SCORED IS NOT NO-MATCH. A grant-level gate (skip_reason /
                        // hard disqualifier) means runMatching never ran, so the default
                        // copy below — "no qualifying matches for the current roster" —
                        // would report a roster scan that never happened. That misreads as
                        // a real negative result, which is worse than saying nothing.
                        : disposition.tier === "not_pursued"
                          ? `Not scored — ${disposition.detail ?? "this grant was gated before matching"}.`
                          // Same reasoning, different cause: no profile means there were no
                          // seats to score against, so nobody could have qualified.
                          : disposition.tier === "profile_gap"
                            ? "Not scored — no ideal-applicant profile was built, so there were no seats to score against."
                            : "No qualifying matches (score 2+) for the current roster."
                }
              />
            </CardContent>
          </Card>

          <ConsortiumPairings pairings={consortiumPairings} />
        </div>

        <div className="space-y-6">
          {canCalibrate && !processing && (
            <Card>
              <CardHeader><CardTitle>Calibration</CardTitle></CardHeader>
              <CardContent className="space-y-4">
                {/* Rendered ONLY when no banner above is already offering it. Three copies
                    of RematchButton could be on screen at once (profile gap, not pursued,
                    incomplete scoring, and this) with the same helper text under each. The
                    control stays next to the problem it solves — a button beside the
                    message that explains it is the useful placement — so this general
                    "re-run after a roster change" copy yields rather than the banners. */}
                {!bannerOffersRematch && (
                  <div className="space-y-2">
                    <p className="text-xs text-muted-foreground">
                      Re-run this grant after a roster or scoring change. Off the daily queue —
                      this is the record, not a working view.
                    </p>
                    <RematchButton grantId={grant.id} />
                  </div>
                )}
                <div className={`space-y-1${bannerOffersRematch ? "" : " border-t pt-3"}`}>
                  <p className="text-xs font-medium">Add to a client</p>
                  <p className="mb-2 text-xs text-muted-foreground">
                    Manually match a client the engine didn&apos;t surface. Scores on demand and
                    adds regardless of a low fit; blocks only on eligibility constraints.
                  </p>
                  <AddToClientControl grantId={grant.id} clients={activeClients} />
                </div>
              </CardContent>
            </Card>
          )}

          <GrantKeyFacts grant={grant} />
        </div>
      </div>
    </div>
  );
}
