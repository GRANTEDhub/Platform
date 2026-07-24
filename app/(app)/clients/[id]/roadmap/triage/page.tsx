import { requireAdmin } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { SwipeDeck } from "@/components/report/swipe-deck";
import { HubShell } from "@/components/layout/hub-background";
import { toReportItems, type ReportCardRow } from "@/lib/report/shape";

export const dynamic = "force-dynamic";

// Staff account-manager Grant Alerts (swipe). For a STANDARD client, this is a
// convenience mirror of the client's OWN gate (0057) -- shows their
// not-yet-interested matches, and swiping right sets THEIR interested_at (staff
// acting on the client's behalf). For an ACCOUNT-MANAGED client (0059), this is
// staff's OWN, separate first pass -- shows matches nobody on staff has looked
// at yet (sme_interested_at), and swiping right sets sme_interested_at instead,
// promoting the card to staff's OWN Grant Report queue, not the client's. Either
// way, left rejects outright (decision='passed'), shared and terminal.
export default async function ClientRoadmapTriage({ params }: { params: { id: string } }) {
  await requireAdmin();
  const supabase = createClient();

  const { data: client } = await supabase
    .from("clients")
    .select("account_managed")
    .eq("id", params.id)
    .single<{ account_managed: boolean }>();
  const managed = !!client?.account_managed;

  let query = supabase
    .from("review_cards")
    .select(
      "id, grant_id, fit_score, proposed_role, decision, factor_scores, concept_synopsis, grants(title, funder, submission_deadline, award_range_min, award_range_max, award_range_is_estimate, focus_areas, total_funding, cost_share, geographic_eligibility, eligible_entity_types, description)",
    )
    .eq("client_id", params.id)
    .eq("decision", "pending")
    .neq("card_type", "prospect");
  query = managed ? query.is("sme_interested_at", null) : query.is("interested_at", null);
  const { data } = await query;

  const items = toReportItems((data ?? []) as unknown as ReportCardRow[]);

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
