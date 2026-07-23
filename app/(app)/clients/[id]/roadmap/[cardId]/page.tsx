import { notFound } from "next/navigation";
import { requireAdmin } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { ReportDetail, type ReportDetailCard } from "@/components/report/report-detail";
import { HubShell } from "@/components/layout/hub-background";
import { deciderLabel } from "@/lib/report/shape";
import type { GrantDetailFields } from "@/components/grants/grant-detail";
import type { Client } from "@/types/database";

export const dynamic = "force-dynamic";

type DetailRow = ReportDetailCard & {
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
// is pinned so the card must belong to the client whose roadmap this is.
export default async function ClientRoadmapDetail({ params }: { params: { id: string; cardId: string } }) {
  const profile = await requireAdmin();
  const supabase = createClient();

  const { data } = await supabase
    .from("review_cards")
    .select(
      "fit_score, proposed_role, why_this_org, concept_synopsis, factor_scores, decision, decided_by, decided_by_actor, grants(id, source_url, title, funder, focus_areas, assistance_listings, submission_deadline, period_of_performance, cost_share, award_range_min, award_range_max, award_range_is_estimate, num_awards, description, eligible_entity_types, geographic_eligibility, ineligible_entities, subaward_prohibited, incumbent_risk, technical_burden_flags, hard_disqualifiers, verification_flags, scoring_rubric, ideal_applicant_profile, grant_status)",
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
    .select("name")
    .eq("id", params.id)
    .single<Pick<Client, "name">>();
  const decidedBy = deciderLabel(
    card.decision,
    card.decided_by,
    card.decided_by_actor,
    profile.id,
    client?.name || "the client",
  );

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
      />
    </HubShell>
  );
}
