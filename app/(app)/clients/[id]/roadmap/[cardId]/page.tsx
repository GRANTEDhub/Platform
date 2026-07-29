import { notFound } from "next/navigation";
import { requireUser } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { ReportDetail, type ReportDetailCard } from "@/components/report/report-detail";
import { ReleaseToClientBar } from "@/components/report/release-bar";
import { ConceptProposalPanel } from "@/components/report/concept-proposal-panel";
import { GenerateConceptButton } from "@/components/report/generate-concept-button";
import { AlertSend } from "@/app/(app)/review/[id]/alert-send";
import { getConceptProposal } from "@/lib/concept/store";
import { getSentAlertForCard } from "@/lib/alerts/sent-status";
import { HubShell } from "@/components/layout/hub-background";
import { deciderLabel } from "@/lib/report/shape";
import { isUnconvertedLead } from "@/lib/leads/stage";
import type { GrantDetailFields } from "@/components/grants/grant-detail";
import type { Client } from "@/types/database";

export const dynamic = "force-dynamic";

type DetailRow = ReportDetailCard & {
  sme_released_at: string | null;
  grants:
    | (GrantDetailFields & {
        title: string | null;
        funder: string | null;
        focus_areas: string[] | null;
        assistance_listings: { number: string; program_title: string }[] | null;
      })
    | null;
};

// Staff account-manager detail — the same read-only ReportDetail the client opens
// from their portal, mounted here so staff review the identical surface. client_id
// is pinned so the card must belong to the client whose roadmap this is. For an
// account-managed client (0059), the normal Pursue/Save/Pass decision cluster is
// swapped for ReleaseToClientBar -- the pursue call is the CLIENT's to make, on
// their own copy of this page, once staff releases it.
export default async function ClientRoadmapDetail({ params }: { params: { id: string; cardId: string } }) {
  const profile = await requireUser();
  const isAdmin = profile.role === "admin";
  const supabase = createClient();

  const { data } = await supabase
    .from("review_cards")
    .select(
      "fit_score, proposed_role, why_this_org, concept_synopsis, factor_scores, decision, decided_by, decided_by_actor, sme_released_at, grants(id, source_url, title, funder, focus_areas, assistance_listings, submission_deadline, period_of_performance, cost_share, award_range_min, award_range_max, award_range_is_estimate, num_awards, description, eligible_entity_types, geographic_eligibility, ineligible_entities, subaward_prohibited, incumbent_risk, technical_burden_flags, hard_disqualifiers, verification_flags, scoring_rubric, ideal_applicant_profile, grant_status)",
    )
    .eq("id", params.cardId)
    .eq("client_id", params.id)
    .neq("card_type", "prospect")
    .maybeSingle();

  const card = data as DetailRow | null;
  if (!card || !card.grants) notFound();

  const g = card.grants;
  const { data: client } = await supabase
    .from("clients")
    .select("name, account_managed, pipeline_stage")
    .eq("id", params.id)
    .single<Pick<Client, "name" | "account_managed" | "pipeline_stage">>();
  // A prospect (un-converted lead) has no portal: the terminal action is a cold
  // one-pager send, not a release.
  const isLead = isUnconvertedLead(client?.pipeline_stage);
  const sentAlert = isLead ? await getSentAlertForCard(params.cardId) : null;
  const decidedBy = deciderLabel(
    card.decision,
    card.decided_by,
    card.decided_by_actor,
    profile.id,
    client?.name || "the client",
  );

  // Concept proposal is an INTERNAL AM artifact — for a premium client (a paid
  // deliverable they later see in the portal) OR a prospect (staff prep only: it is
  // NEVER emailed to the prospect; per policy the prospect gets the one-pager, not
  // the paid concept). Rendered on this staff surface, never on a client's own copy.
  // ADMIN-ONLY: concept_proposals is is_admin() RLS (the paid-deliverable firewall),
  // so it is hidden from contractors here just as it is in IntellEngine -- a
  // contractor sees the read-only report without the concept panel/generate.
  const showConcept = isAdmin && (!!client?.account_managed || isLead);
  const conceptProposal = showConcept ? await getConceptProposal(params.cardId) : null;

  return (
    <HubShell variant="map">
      <ReportDetail
        cardId={params.cardId}
        card={card}
        grant={g}
        title={g.title || "Untitled opportunity"}
        funder={g.funder}
        focusAreas={(g.focus_areas ?? []).slice(0, 3)}
        deciderLabel={decidedBy}
        backHref={`/clients/${params.id}/roadmap`}
        decisionBar={
          client?.account_managed ? (
            <ReleaseToClientBar
              cardId={params.cardId}
              released={!!card.sme_released_at}
              backHref={`/clients/${params.id}/roadmap`}
            />
          ) : isLead ? (
            // Two actions, side by side: send the one-pager, or (internal) generate a
            // concept proposal. The concept button generates in one click; the result
            // renders in the panel below. It is never emailed to the prospect.
            <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2">
              <AlertSend
                cardId={params.cardId}
                sentAt={sentAlert?.sentAt ?? null}
                sentTo={sentAlert?.sentTo ?? null}
                contactName={client?.name ?? null}
              />
              <GenerateConceptButton cardId={params.cardId} status={conceptProposal?.status ?? null} />
            </div>
          ) : undefined
        }
        afterContent={
          showConcept ? (
            <div id="concept" className="scroll-mt-24">
              <ConceptProposalPanel cardId={params.cardId} initial={conceptProposal} />
            </div>
          ) : undefined
        }
      />
    </HubShell>
  );
}
