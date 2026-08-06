import { requireClientOrAdmin } from "@/lib/auth";
import { requirePursuitVisible } from "@/lib/pursuit/access";
import { resolveIntellEngineContext } from "@/lib/intellengine/context";
import { computeEligibility } from "@/lib/intellengine/eligibility";
import IntellEngineComplianceClient from "./compliance-client";

export const dynamic = "force-dynamic";

export default async function IntellEngineCompliance({ searchParams }: { searchParams: { draft?: string } }) {
  await requireClientOrAdmin();
  await requirePursuitVisible();
  // Real per-client NOFO eligibility read for a matched grant (null for a
  // from-scratch draft or a staff preview -- no grant, so no gate is shown).
  const ctx = await resolveIntellEngineContext(searchParams.draft);
  const verdict = ctx?.grant
    ? computeEligibility({
        eligibleEntityTypes: ctx.grant.eligible_entity_types,
        ineligibleEntities: ctx.grant.ineligible_entities,
        hardDisqualifiers: ctx.grant.hard_disqualifiers,
        skipReason: ctx.grant.skip_reason,
        geographicEligibility: ctx.grant.geographic_eligibility,
        clientOrgType: ctx.client?.org_type ?? null,
        clientState: ctx.client?.location_state ?? null,
      })
    : null;
  return <IntellEngineComplianceClient draftId={searchParams.draft} verdict={verdict} />;
}
