import { requireClient } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { GrantReport } from "@/components/report/grant-report";
import { HubShell } from "@/components/layout/hub-background";
import { toReportItems, type ReportCardRow } from "@/lib/report/shape";

export const dynamic = "force-dynamic";

// Grant Ledger — a read-only historical record of every grant ever matched for
// this client, whatever it decided (approved / passed / still pending). Reuses
// the exact Grant Report surface + shaping (already client-safe), just without
// the ".neq('decision', 'passed')" filter the active Report applies -- this is
// the one place archived/rejected matches remain visible to the client.
//
// Account-managed clients (0059) keep the SAME release gate as everywhere else:
// a card staff haven't released yet must stay invisible here too, or this page
// would reopen the exact leak fixed on the dashboard (unreleased matches must
// never be countable, visible, or inferable client-side before release).
export default async function PortalLedger() {
  const { memberships } = await requireClient();
  const org = memberships[0];
  const supabase = createClient();

  const { data: client } = await supabase
    .from("clients")
    .select("account_managed")
    .eq("id", org.clientId)
    .single<{ account_managed: boolean }>();

  // Typed `any`: reassigning with the conditional `.not()` chain below sends the
  // Supabase query builder's generic into a "type instantiation is excessively
  // deep" error if left inferred (same issue as the staff roadmap query).
  let query: any = supabase
    .from("review_cards")
    .select(
      "id, grant_id, fit_score, proposed_role, decision, factor_scores, grants(title, funder, submission_deadline, award_range_min, award_range_max, award_range_is_estimate, focus_areas)",
    )
    .eq("client_id", org.clientId)
    .neq("card_type", "prospect");
  if (client?.account_managed) query = query.not("sme_released_at", "is", null);
  const { data } = await query;

  const items = toReportItems((data ?? []) as unknown as ReportCardRow[]);
  const subtitle =
    items.length === 0
      ? "Every grant we surface for you will show up here, along with what came of it."
      : `${items.length} ${items.length === 1 ? "grant" : "grants"} surfaced for you, all-time`;

  return (
    <HubShell variant="texture" width="7xl">
      <GrantReport items={items} heading={`${org.clientName} · Grant Ledger`} subtitle={subtitle} basePath="/portal/grants" />
    </HubShell>
  );
}
