import Link from "next/link";
import { ArrowLeft } from "lucide-react";
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
// We show every interested card -- pending, approved, AND passed. Passed grants
// are hidden from the default view but reachable under the "Passed" filter: that
// filter is the folded-in Grant Ledger (the separate /portal/ledger tile is gone),
// the archive of grants the client looked at and declined. review_cards only ever
// holds engine-qualifying matches, so every row is a vetted opportunity.
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
      "id, grant_id, fit_score, proposed_role, decision, factor_scores, pursuit_path, grants(title, funder, submission_deadline, award_range_min, award_range_max, award_range_is_estimate, focus_areas)",
    )
    .eq("client_id", org.clientId)
    .neq("card_type", "prospect")
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
  // Subtitle counts the ACTIVE opportunities only -- passed grants live under the
  // "Passed" filter and shouldn't inflate the headline count.
  const activeCount = items.filter((i) => i.decision !== "passed").length;
  const subtitle =
    activeCount === 0
      ? "Your matched opportunities will appear here, ranked by fit."
      : `${activeCount} matched ${activeCount === 1 ? "opportunity" : "opportunities"} · Ranked by fit`;

  return (
    <HubShell variant="texture" width="7xl">
      <Link
        href="/portal"
        className="mb-6 inline-flex items-center gap-1.5 text-sm font-medium text-muted-foreground transition-colors hover:text-brand-navy"
      >
        <ArrowLeft className="h-4 w-4" />
        Dashboard
      </Link>
      <GrantReport
        items={items}
        heading={`${org.clientName} · Grant Report`}
        subtitle={subtitle}
        basePath="/portal/grants"
        clientName={org.clientName}
        tier={tier}
      />
    </HubShell>
  );
}
