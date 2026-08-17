import { requireClient } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { SwipeDeck } from "@/components/report/swipe-deck";
import { toReportItems, withConcept, type ReportCardRow } from "@/lib/report/shape";
import { getConceptProposalsByCardIds } from "@/lib/concept/store";

export const dynamic = "force-dynamic";

// Grant Alerts (swipe) for the client's brand-new, not-yet-triaged matches (the
// gate ahead of the Grant Report; see migration 0057). Right = Interested (sets
// interested_at, promotes to the Grant Report -- does not touch decision), left =
// Archive (decision='passed'), under RLS as the logged-in client.
//
// Account-managed clients (0059) only see a card here once staff has released it
// (sme_released_at set) -- their account manager's own Grant Alerts/Report pass
// happens first, invisibly to the client, on the staff roadmap pages.
export default async function PortalTriage({ searchParams }: { searchParams: { card?: string } }) {
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
      "id, grant_id, fit_score, proposed_role, decision, factor_scores, concept_synopsis, grants(title, funder, fon, source_url, submission_deadline, award_range_min, award_range_max, award_range_is_estimate, focus_areas, total_funding, cost_share, geographic_eligibility, eligible_entity_types, description)",
    )
    .eq("client_id", org.clientId)
    .eq("decision", "pending")
    .is("interested_at", null)
    .neq("card_type", "prospect");
  if (client?.account_managed) query = query.not("sme_released_at", "is", null);
  const { data } = await query;

  const baseItems = toReportItems((data ?? []) as unknown as ReportCardRow[], "client");

  // Premium (account-managed) clients see their team's finalized concept proposal
  // right on the alert card, read-only; base clients get the upsell teaser. The
  // proposals live in an admin-only table, so fetch them service-role and stamp
  // onto the items (base tier needs no fetch -- the teaser is pure UI).
  const tier = client?.account_managed ? "premium" : "base";
  const byCard =
    tier === "premium"
      ? await getConceptProposalsByCardIds(baseItems.map((i) => i.id))
      : new Map();
  const items = withConcept(baseItems, tier, byCard);

  // No HubShell: the alert redesign is full-bleed (road photo + navy scrim) and fills the
  // portal <main> under the nav itself, so it provides its own backdrop rather than sitting in
  // a max-width HubShell column.
  return (
    <SwipeDeck
      items={items}
      detailBasePath="/portal/grants"
      backHref="/portal/grants"
      clientName={org.clientName}
      // ?card= comes from the alert email: open on the grant we wrote to them about.
      // A card they have already answered is not in `items`, so the deck falls back to
      // the front of the queue rather than 404-ing an old link.
      startCardId={searchParams?.card}
      // Client portal: a Pass here is the client's calibration signal, so require the reason
      // (matches the DecisionBar grant-report guard). Staff triage leaves it optional.
      requireReason
      // #12: turns on the branded rotating-logo transition after each decision. "/portal" is
      // the client dashboard — where the deck routes once no alerts remain.
      dashboardHref="/portal"
      // Client Grant Alert redesign — the full-bleed immersive card. Client portal only.
      presentation="alert"
    />
  );
}
