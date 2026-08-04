import { requireClient } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { GrantReportConsole } from "@/components/report/grant-report-console";
import { buildQueue } from "@/lib/report/report-queue";
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

  // SAME COMPONENT AS STAFF, variant="portal". The client used GrantReport, the last
  // pre-redesign list in the product; the two are meant to be one screen so a change lands
  // on both instead of the portal drifting a release behind.
  //
  // hasReleaseGate FALSE, and that is the whole reason the tab sets differ in length: with
  // no gate staffBucket never returns "admin", so a client's grants fall into
  // client / pursued / rejected -- awaiting their review, being pursued, passed. Their
  // untriaged matches are not here at all (the query requires interested_at); those live
  // in Grant Alerts.
  const rows = buildQueue(items, { hasReleaseGate: false, primaryBucket: "client" });
  return (
    // NO HubShell and no wrapper back-link: GrantReportConsole is a full-height screen that
    // renders its own header (back link, title, stats) exactly as it does for staff, and the
    // portal layout's <main> is flex-1 with the scroll — the same definite-height parent the
    // console gives it. Wrapping it in a centred texture column is what made the old list a
    // different-looking screen.
    <GrantReportConsole
      variant="portal"
      clientName={org.clientName}
      clientHref="/portal"
      backLabel="Dashboard"
      basePath="/portal/grants"
      rows={rows}
      // Staff-only: "last refreshed" comes from match_attempts, which is staff-only under
      // RLS (0055), and it reads as a promise about how often we look.
      refreshedLabel={null}
      // Bulk-archiving closed grants is a staff queue action. A client's own passed
      // deadlines are theirs to decide on one at a time.
      canArchive={false}
    />
  );
}
