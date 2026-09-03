import { redirect } from "next/navigation";
import { requireUser } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { SwipeDeck } from "@/components/report/swipe-deck";
import { HubShell } from "@/components/layout/hub-background";
import { toReportItems, type ReportCardRow } from "@/lib/report/shape";

export const dynamic = "force-dynamic";

// Staff account-manager Grant Alerts (swipe) -- STANDARD clients only now. It is a
// convenience mirror of the client's OWN gate (0057): shows their not-yet-interested
// matches, and swiping right sets THEIR interested_at (staff acting on the client's
// behalf); left rejects outright (decision='passed'), shared and terminal.
//
// ACCOUNT-MANAGED clients no longer have this first-pass gate. Their review is a
// SINGLE gate on the roadmap review list (where the why-it-matches detail, the manual
// concept-proposal generate/edit, and the release-to-client action all live), so a
// managed client is redirected there -- keeping one gate, not two.
export default async function ClientRoadmapTriage({ params }: { params: { id: string } }) {
  await requireUser();
  const supabase = createClient();

  const { data: client } = await supabase
    .from("clients")
    .select("account_managed")
    .eq("id", params.id)
    .single<{ account_managed: boolean }>();
  const managed = !!client?.account_managed;
  if (managed) redirect(`/clients/${params.id}/roadmap`);

  let query = supabase
    .from("review_cards")
    .select(
      "id, grant_id, fit_score, proposed_role, decision, factor_scores, qa_fit_score, qa_factor_scores, qa_sources, qa_status, qa_engine_fit_score, concept_synopsis, grants(title, funder, submission_deadline, award_range_min, award_range_max, award_range_is_estimate, num_awards, focus_areas, total_funding, cost_share, geographic_eligibility, eligible_entity_types, description)",
    )
    .eq("client_id", params.id)
    .eq("decision", "pending")
    .neq("card_type", "prospect");
  query = managed ? query.is("sme_interested_at", null) : query.is("interested_at", null);
  const { data } = await query;

  const items = toReportItems((data ?? []) as unknown as ReportCardRow[], "staff");

  return (
    <HubShell variant="texture">
      <SwipeDeck
        items={items}
        detailBasePath={`/clients/${params.id}/roadmap`}
        backHref={`/clients/${params.id}/roadmap`}
        interestMode={managed ? "sme" : "client"}
      />
    </HubShell>
  );
}
