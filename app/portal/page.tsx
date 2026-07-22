import { requireClient } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { GrantReport } from "@/components/report/grant-report";
import { HubShell } from "@/components/layout/hub-background";
import { toReportItems, type ReportCardRow } from "@/lib/report/shape";

export const dynamic = "force-dynamic";

// The client's Grant Roadmap — the portal's primary surface (Slice 1). Reads
// review_cards under RLS as the logged-in client (NOT the service role), so the
// list can only ever contain THIS client's own matches; the 0055 policies enforce
// the isolation. Read-only for now; actor-aware decisions + score feedback layer
// on in Slice 2, the interactive swipe in Slice 3.
//
// We show pending + approved client cards (passed are hidden). review_cards only
// ever holds engine-qualifying matches, so every row is a vetted opportunity —
// "Pursuing" (approved) carries its badge; the rest await a decision.
export default async function PortalHome() {
  const { memberships } = await requireClient();
  const org = memberships[0];
  const supabase = createClient();

  const { data } = await supabase
    .from("review_cards")
    .select(
      "id, grant_id, fit_score, proposed_role, decision, factor_scores, grants(title, funder, submission_deadline, award_range_min, award_range_max, award_range_is_estimate, focus_areas)",
    )
    .eq("client_id", org.clientId)
    .neq("card_type", "prospect")
    .neq("decision", "passed");

  const items = toReportItems((data ?? []) as unknown as ReportCardRow[]);
  const subtitle =
    items.length === 0
      ? "Your matched opportunities will appear here, ranked by fit."
      : `${items.length} matched ${items.length === 1 ? "opportunity" : "opportunities"} · Ranked by fit`;

  return (
    <HubShell variant="crisp" width="7xl">
      <GrantReport
        items={items}
        heading={`${org.clientName} · Grant Roadmap`}
        subtitle={subtitle}
        basePath="/portal/grants"
        triageHref="/portal/triage"
      />
    </HubShell>
  );
}
