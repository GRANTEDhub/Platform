import { requireAdmin } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { SwipeDeck } from "@/components/report/swipe-deck";
import { HubShell } from "@/components/layout/hub-background";
import { toReportItems, type ReportCardRow } from "@/lib/report/shape";

export const dynamic = "force-dynamic";

// Staff account-manager Grant Alerts (swipe) — the same SwipeDeck the client uses,
// over a client's NOT-YET-INTERESTED matches (the gate ahead of the Grant Report;
// see migration 0057). Swiping right marks interested (promotes to Grant Report,
// doesn't touch decision); left rejects outright (decision='passed'). Writes go
// through the shared PATCH route, actor-stamped 'staff'.
export default async function ClientRoadmapTriage({ params }: { params: { id: string } }) {
  await requireAdmin();
  const supabase = createClient();

  const { data } = await supabase
    .from("review_cards")
    .select(
      "id, grant_id, fit_score, proposed_role, decision, factor_scores, concept_synopsis, grants(title, funder, submission_deadline, award_range_min, award_range_max, award_range_is_estimate, focus_areas, total_funding, cost_share, geographic_eligibility, eligible_entity_types, description)",
    )
    .eq("client_id", params.id)
    .eq("decision", "pending")
    .is("interested_at", null)
    .neq("card_type", "prospect");

  const items = toReportItems((data ?? []) as unknown as ReportCardRow[]);

  return (
    <HubShell variant="texture">
      <SwipeDeck
        items={items}
        detailBasePath={`/clients/${params.id}/roadmap`}
        backHref={`/clients/${params.id}/roadmap`}
      />
    </HubShell>
  );
}
