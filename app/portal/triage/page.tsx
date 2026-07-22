import { requireClient } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { SwipeDeck } from "@/components/report/swipe-deck";
import { toReportItems, type ReportCardRow } from "@/lib/report/shape";

export const dynamic = "force-dynamic";

// Swipe-triage for the client's undecided (pending) matches. Right = Interested
// (approved), left = Archive (passed) — the same decision write the roadmap uses,
// under RLS as the logged-in client. Approved picks then surface as "Pursuing" on
// the roadmap.
export default async function PortalTriage() {
  const { memberships } = await requireClient();
  const org = memberships[0];
  const supabase = createClient();

  const { data } = await supabase
    .from("review_cards")
    .select(
      "id, grant_id, fit_score, proposed_role, decision, factor_scores, grants(title, funder, submission_deadline, award_range_min, award_range_max, award_range_is_estimate, focus_areas)",
    )
    .eq("client_id", org.clientId)
    .eq("decision", "pending")
    .neq("card_type", "prospect");

  const items = toReportItems((data ?? []) as unknown as ReportCardRow[]);

  return <SwipeDeck items={items} detailBasePath="/portal/grants" backHref="/portal" />;
}
