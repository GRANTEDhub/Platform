import { requireClient } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { SwipeDeck } from "@/components/report/swipe-deck";
import { HubShell } from "@/components/layout/hub-background";
import { toReportItems, type ReportCardRow } from "@/lib/report/shape";

export const dynamic = "force-dynamic";

// Grant Alerts (swipe) for the client's brand-new, not-yet-triaged matches (the
// gate ahead of the Grant Report; see migration 0057). Right = Interested (sets
// interested_at, promotes to the Grant Report -- does not touch decision), left =
// Archive (decision='passed'), under RLS as the logged-in client.
//
// Account-managed clients (0059) only see a card here once staff has released it
// (sme_released_at set) -- their account manager's own Grant Alerts/Report pass
// happens first, invisibly to the client, on the staff roadmap pages.
export default async function PortalTriage() {
  const { memberships } = await requireClient();
  const org = memberships[0];
  const supabase = createClient();

  const { data: client } = await supabase
    .from("clients")
    .select("account_managed")
    .eq("id", org.clientId)
    .single<{ account_managed: boolean }>();

  let query = supabase
    .from("review_cards")
    .select(
      "id, grant_id, fit_score, proposed_role, decision, factor_scores, concept_synopsis, grants(title, funder, submission_deadline, award_range_min, award_range_max, award_range_is_estimate, focus_areas, total_funding, cost_share, geographic_eligibility, eligible_entity_types, description)",
    )
    .eq("client_id", org.clientId)
    .eq("decision", "pending")
    .is("interested_at", null)
    .neq("card_type", "prospect");
  if (client?.account_managed) query = query.not("sme_released_at", "is", null);
  const { data } = await query;

  const items = toReportItems((data ?? []) as unknown as ReportCardRow[]);

  return (
    <HubShell variant="texture">
      <SwipeDeck items={items} detailBasePath="/portal/grants" backHref="/portal/grants" />
    </HubShell>
  );
}
