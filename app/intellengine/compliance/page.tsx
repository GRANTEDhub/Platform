import { requireClientOrAdmin } from "@/lib/auth";
import { requirePursuitVisible } from "@/lib/pursuit/access";
import { resolveIntellEngineContext } from "@/lib/intellengine/context";
import { computeEligibility } from "@/lib/intellengine/eligibility";
import {
  readApplicationRequirements,
  requirementsRetrievable,
  requirementsClientVisible,
  MAX_REQUIREMENTS_ATTEMPTS,
} from "@/lib/grants/requirements";
import type { Grant } from "@/types/database";
import IntellEngineComplianceClient from "./compliance-client";

export const dynamic = "force-dynamic";

export default async function IntellEngineCompliance({ searchParams }: { searchParams: { draft?: string } }) {
  const { isStaff } = await requireClientOrAdmin();
  await requirePursuitVisible();
  // Real per-client NOFO eligibility read for a matched grant (null for a
  // from-scratch draft or a staff preview -- no grant, so no gate is shown).
  const ctx = await resolveIntellEngineContext(searchParams.draft);
  const grant = (ctx?.grant ?? null) as Grant | null;
  const verdict = grant
    ? computeEligibility({
        eligibleEntityTypes: grant.eligible_entity_types,
        ineligibleEntities: grant.ineligible_entities,
        hardDisqualifiers: grant.hard_disqualifiers,
        skipReason: grant.skip_reason,
        geographicEligibility: grant.geographic_eligibility,
        clientOrgType: ctx?.client?.org_type ?? null,
        clientState: ctx?.client?.location_state ?? null,
      })
    : null;

  // ── Application requirements (0081), grant-level, quote-grounded, ADVISORY ──────────────────
  //
  // Read the cached artifact off the grant (context.ts already selects it). Visibility: staff
  // always (to preview + watch the drop rate), clients only once APPLICATION_REQUIREMENTS_CLIENT_VISIBLE
  // is flipped on. `canDerive` is the staff-only, lazy trigger: offered only when nothing is cached,
  // the NOFO is retrievable, and the retry cap is not spent. computeEligibility is untouched and
  // stays the sole eligibility surface -- this section never repeats it.
  const requirements = grant ? readApplicationRequirements(grant.application_requirements) : null;
  const showRequirements = !!grant && (isStaff || requirementsClientVisible());
  const retrievable = !!grant && requirementsRetrievable(grant);
  const attemptsExhausted = (grant?.application_requirements_attempts ?? 0) >= MAX_REQUIREMENTS_ATTEMPTS;
  // Only staff derive during the MVP; the route enforces this too. Nothing cached + retrievable +
  // attempts left.
  const canDerive = showRequirements && isStaff && !requirements && retrievable && !attemptsExhausted;

  return (
    <IntellEngineComplianceClient
      draftId={searchParams.draft}
      verdict={verdict}
      showRequirements={showRequirements}
      requirements={requirements}
      canDerive={canDerive}
      retrievable={retrievable}
      attemptsExhausted={attemptsExhausted}
    />
  );
}
