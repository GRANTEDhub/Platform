import Link from "next/link";
import { notFound } from "next/navigation";
import { requireUser } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { PageHeader } from "@/components/layout/page-header";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ScoreBadge, DecisionBadge } from "@/components/grants/badges";
import { DecisionBar } from "./decision-bar";
import { MatchFeedback } from "./match-feedback";
import type { ReviewCard, Client, Grant } from "@/types/database";

export const dynamic = "force-dynamic";

type FullCard = ReviewCard & {
  clients: Pick<Client, "id" | "name" | "org_type" | "engagement_tier"> | null;
  grants: Pick<Grant, "id" | "title" | "funder" | "fon" | "source_url" | "submission_deadline" | "cost_share" | "award_range_min" | "award_range_max" | "award_range_is_estimate"> | null;
};

export default async function CardDetailPage({ params }: { params: { id: string } }) {
  const profile = await requireUser();
  const supabase = createClient();

  const { data } = await supabase
    .from("review_cards")
    .select("*, clients(id, name, org_type, engagement_tier), grants(id, title, funder, fon, source_url, submission_deadline, cost_share, award_range_min, award_range_max, award_range_is_estimate)")
    .eq("id", params.id)
    .single();

  const card = data as FullCard | null;
  if (!card) notFound();

  const rc = card.reasoning_context || {};

  return (
    <div>
      <PageHeader
        title={card.clients?.name || "Match"}
        description={card.grants?.title || undefined}
        action={<DecisionBadge decision={card.decision} />}
      />

      <div className="grid gap-6 p-8 lg:grid-cols-3">
        <div className="space-y-6 lg:col-span-2">
          <Card>
            <CardHeader className="flex-row items-center justify-between space-y-0">
              <CardTitle>Fit</CardTitle>
              <ScoreBadge score={card.fit_score} />
            </CardHeader>
            <CardContent className="space-y-4 text-sm">
              {rc.fit_score_derivation && (
                <div className="rounded-md border bg-muted/30 p-3">
                  <p className="text-xs uppercase tracking-wide text-muted-foreground">How this score was reached</p>
                  <p className="mt-1 leading-relaxed">{rc.fit_score_derivation}</p>
                </div>
              )}
              <Detail label="Proposed role" value={card.proposed_role} />
              {card.recommended_prime && <Detail label="Recommended prime" value={card.recommended_prime} />}
              {(card.why_this_org?.length || 0) > 0 && (
                <div>
                  <p className="text-xs uppercase tracking-wide text-muted-foreground">Why this org</p>
                  <ul className="mt-1 list-disc space-y-1 pl-4">
                    {card.why_this_org!.map((w, i) => <li key={i}>{w}</li>)}
                  </ul>
                </div>
              )}
              {card.concept_synopsis && <Detail label="Concept" value={card.concept_synopsis} />}
            </CardContent>
          </Card>

          {(card.before_you_approve?.length || 0) > 0 && (
            <Card>
              <CardHeader><CardTitle>Before you approve</CardTitle></CardHeader>
              <CardContent>
                <ul className="list-disc space-y-1 pl-4 text-sm">
                  {card.before_you_approve!.map((b, i) => <li key={i}>{b}</li>)}
                </ul>
                {(card.inferred_fields?.length || 0) > 0 && (
                  <p className="mt-3 text-xs text-muted-foreground">
                    Inferred (not confirmed): {card.inferred_fields!.join(", ")}
                  </p>
                )}
              </CardContent>
            </Card>
          )}

          {(card.final_outreach_email || card.draft_outreach_email) && (
            <Card>
              <CardHeader><CardTitle>
                {card.final_outreach_email
                  ? "Approved email (to send)"
                  : `Draft outreach${card.outreach_track ? ` · ${card.outreach_track}` : ""}`}
              </CardTitle></CardHeader>
              <CardContent>
                <pre className="whitespace-pre-wrap font-sans text-sm">
                  {card.final_outreach_email || card.draft_outreach_email}
                </pre>
              </CardContent>
            </Card>
          )}

          {Object.keys(rc).length > 0 && (
            <Card>
              <CardHeader><CardTitle>Reasoning</CardTitle></CardHeader>
              <CardContent className="space-y-3 text-sm">
                {rc.eligibility_analysis && <Detail label="Eligibility" value={rc.eligibility_analysis} />}
                {rc.role_assignment_logic && <Detail label="Role logic" value={rc.role_assignment_logic} />}
                {rc.consortium_rationale && <Detail label="Consortium" value={rc.consortium_rationale} />}
                {rc.why_not_others && <Detail label="Why not others" value={rc.why_not_others} />}
              </CardContent>
            </Card>
          )}
        </div>

        <div className="space-y-6">
          <Card>
            <CardHeader><CardTitle>Decision</CardTitle></CardHeader>
            <CardContent>
              <DecisionBar
                cardId={card.id}
                decision={card.decision}
                isAdmin={profile.role === "admin"}
                draft={card.draft_outreach_email ?? ""}
                finalEmail={card.final_outreach_email}
              />
              {card.decision === "hold" && card.hold_reason && (
                <p className="mt-3 text-xs text-muted-foreground">Hold: {card.hold_reason}</p>
              )}
              {card.decision === "passed" && card.decision_reason && (
                <p className="mt-3 text-xs text-muted-foreground">Rejected: {card.decision_reason}</p>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader><CardTitle>Score feedback</CardTitle></CardHeader>
            <CardContent>
              <MatchFeedback cardId={card.id} />
            </CardContent>
          </Card>

          <Card>
            <CardHeader><CardTitle>Opportunity</CardTitle></CardHeader>
            <CardContent className="space-y-3 text-sm">
              <Detail label="Funder" value={card.grants?.funder} />
              <Detail label="Deadline" value={card.grants?.submission_deadline} />
              <Detail
                label="Award range"
                value={
                  card.grants?.award_range_min || card.grants?.award_range_max
                    ? `${card.grants?.award_range_min || "?"} – ${card.grants?.award_range_max || "?"}${card.grants?.award_range_is_estimate ? " (estimate)" : ""}`
                    : undefined
                }
              />
              {card.grants?.id && (
                <Link href={`/grants/${card.grants.id}`} className="block text-primary hover:underline">
                  Full grant detail →
                </Link>
              )}
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}

function Detail({ label, value }: { label: string; value: string | null | undefined }) {
  if (!value) return null;
  return (
    <div>
      <p className="text-xs uppercase tracking-wide text-muted-foreground">{label}</p>
      <p className="mt-0.5 whitespace-pre-wrap leading-relaxed">{value}</p>
    </div>
  );
}
