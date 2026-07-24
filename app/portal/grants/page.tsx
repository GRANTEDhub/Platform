import { requireClient } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { GrantReport } from "@/components/report/grant-report";
import { HubShell } from "@/components/layout/hub-background";
import { toReportItems, withConcept, type ReportCardRow } from "@/lib/report/shape";
import { getConceptProposalsByCardIds } from "@/lib/concept/store";

export const dynamic = "force-dynamic";

// The client's Grant Report — moved here from /portal (Phase 2) now that /portal
// is the dashboard. Reads review_cards under RLS as the logged-in client (NOT the
// service role), so the list can only ever contain THIS client's own matches; the
// 0055 policies enforce the isolation.
//
// We show pending + approved client cards (passed are hidden). review_cards only
// ever holds engine-qualifying matches, so every row is a vetted opportunity —
// "Pursuing" (approved) carries its badge; the rest await a decision.
//
// Grant Alerts gate (0057): a card only lands here once it's been marked
// interested in Grant Alerts -- brand-new, not-yet-triaged matches live there
// instead, not here.
export default async function PortalGrantReport() {
  const { memberships } = await requireClient();
  const org = memberships[0];
  const supabase = createClient();

  const { data: client } = await supabase
    .from("clients")
    .select("account_managed")
    .eq("id", org.clientId)
    .single<{ account_managed: boolean }>();

  const { data } = await supabase
    .from("review_cards")
    .select(
      "id, grant_id, fit_score, proposed_role, decision, factor_scores, grants(title, funder, submission_deadline, award_range_min, award_range_max, award_range_is_estimate, focus_areas)",
    )
    .eq("client_id", org.clientId)
    .neq("card_type", "prospect")
    .neq("decision", "passed")
    .not("interested_at", "is", null);

  const baseItems = toReportItems((data ?? []) as unknown as ReportCardRow[]);

  // Same concept-proposal reveal as Grant Alerts, now that the grant is in the
  // Report: premium clients see the read-only proposal, base clients the upsell
  // teaser. Fetched service-role (admin-only table) and stamped onto the items.
  const tier = client?.account_managed ? "premium" : "base";
  const byCard =
    tier === "premium"
      ? await getConceptProposalsByCardIds(baseItems.map((i) => i.id))
      : new Map();
  const items = withConcept(baseItems, tier, byCard);
  const subtitle =
    items.length === 0
      ? "Your matched opportunities will appear here, ranked by fit."
      : `${items.length} matched ${items.length === 1 ? "opportunity" : "opportunities"} · Ranked by fit`;

  return (
    <HubShell variant="texture" width="7xl">
      <GrantReport
        items={items}
        heading={`${org.clientName} · Grant Report`}
        subtitle={subtitle}
        basePath="/portal/grants"
        clientName={org.clientName}
      />
    </HubShell>
  );
}
