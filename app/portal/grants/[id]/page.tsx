import { notFound } from "next/navigation";
import { requireClient } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { ReportDetail, type ReportDetailCard } from "@/components/report/report-detail";
import { HubShell } from "@/components/layout/hub-background";
import { deciderLabel } from "@/lib/report/shape";
import type { GrantDetailFields } from "@/components/grants/grant-detail";

export const dynamic = "force-dynamic";

type DetailRow = ReportDetailCard & {
  card_type: string;
  grants:
    | (GrantDetailFields & {
        title: string | null;
        funder: string | null;
        focus_areas: string[] | null;
        assistance_listings: { number: string; program_title: string }[] | null;
      })
    | null;
};

// Read-only Grant Report detail in the client portal. RLS-scoped: the card is
// fetched as the logged-in client, and we additionally pin client_id so a member
// can only open their own org's match. Renders the shared ReportDetail — the same
// surface the staff account-manager view will mount in a later slice.
export default async function PortalGrantDetail({ params }: { params: { id: string } }) {
  const { memberships } = await requireClient();
  const org = memberships[0];
  const supabase = createClient();

  const { data } = await supabase
    .from("review_cards")
    .select(
      "fit_score, proposed_role, why_this_org, concept_synopsis, factor_scores, decision, decided_by, decided_by_actor, card_type, grants(id, source_url, title, funder, focus_areas, assistance_listings, submission_deadline, period_of_performance, cost_share, award_range_min, award_range_max, award_range_is_estimate, num_awards, description, eligible_entity_types, geographic_eligibility, ineligible_entities, subaward_prohibited, incumbent_risk, technical_burden_flags, hard_disqualifiers, verification_flags, scoring_rubric, ideal_applicant_profile, grant_status)",
    )
    .eq("id", params.id)
    .eq("client_id", org.clientId)
    .neq("card_type", "prospect")
    .maybeSingle();

  const card = data as DetailRow | null;
  if (!card || !card.grants) notFound();

  const g = card.grants;
  const {
    data: { user },
  } = await supabase.auth.getUser();
  const decidedBy = deciderLabel(card.decision, card.decided_by, card.decided_by_actor, user?.id ?? null, org.clientName);

  return (
    <HubShell variant="texture">
      <ReportDetail
        cardId={params.id}
        card={card}
        grant={g}
        title={g.title || "Untitled opportunity"}
        funder={g.funder}
        focusAreas={(g.focus_areas ?? []).slice(0, 3)}
        deciderLabel={decidedBy}
        backHref="/portal"
      />
    </HubShell>
  );
}
