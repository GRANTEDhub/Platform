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
    .order("fit_score", { ascending: false });

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

  const canCalibrate = profile.role === "admin" && grant.is_domestic;

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

          {!processing && !forecasted && grant.status !== "error" &&
            grant.shred_depth === "full" && !grant.ideal_applicant_profile && (
              <div className="rounded-lg border border-amber-300 bg-amber-50 p-4">
                <p className="text-sm font-medium text-amber-900">
                  Profile not built — this grant can&apos;t match
                </p>
                <p className="mt-1 text-sm text-amber-800">
                  The NOFO shredded fully, but building the ideal-applicant profile (Stage A)
                  failed, so no client can score against it. Rebuild the grant profile to retry.
                </p>
                {grant.ideal_profile_error && (
                  <p className="mt-2 whitespace-pre-wrap font-mono text-xs text-amber-900/80">
                    {grant.ideal_profile_error}
                  </p>
                )}
                {canCalibrate && (
                  <div className="mt-3">
                    <RematchButton grantId={grant.id} />
                  </div>
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
              {canCalibrate && (
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
                emptyText={
                  processing
                    ? "Scoring in progress…"
                    : !grant.is_domestic
                      ? "International opportunity — excluded from matching by policy."
                      : erroredClientCount > 0
                        ? "Scoring was incomplete — see the notice above. Re-match to retry before treating this as a no-match."
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
                <div className="space-y-2">
                  <p className="text-xs text-muted-foreground">
                    Re-run this grant after a roster or scoring change. Off the daily queue —
                    this is the record, not a working view.
                  </p>
                  <RematchButton grantId={grant.id} />
                </div>
                <div className="space-y-1 border-t pt-3">
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
