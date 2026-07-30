"use client";

import { WebsiteDraftButton } from "@/components/intake/website-draft-button";
import {
  useNarrative,
  NarrativeHiddenInput,
  FundingNeedField,
  MissionField,
  ProgramsSection,
  PriorityAreasSection,
  PartnersSection,
  AdditionalInfoField,
} from "@/components/intake/narrative-parts";
import { type NarrativeIntake } from "@/lib/intake/narrative";

// ONE-PAGE narrative block: the public intake form and the client EDIT page. Now a
// thin composition of the shared parts in narrative-parts.tsx (which is also what the
// multi-step create wizard composes, page by page) so the two surfaces can never
// drift in what they capture.
//
// Props are unchanged from the pre-refactor component, so both existing call sites
// keep working untouched. Occupancy-facing / matcher-config fields
// (hard_constraints, matching_rules, engagement_tier, budget/RUCC/match/service_area)
// deliberately live OUTSIDE this component.
export function NarrativeFields({
  defaultValue,
  fundingNeedRequired,
  websiteForDraft,
  variant = "full",
}: {
  defaultValue?: NarrativeIntake;
  fundingNeedRequired?: boolean;
  // When provided (admin client form), shows a "Draft from website" button that
  // fills mission + funding_need from the org's site. Absent on the public intake.
  websiteForDraft?: string;
  // "light" (prospect intake) shows only the matching-relevant core — intent
  // ("what are you looking for"), identity (mission), and priority areas. "full"
  // (clients + public intake) adds programs, partnerships, and "anything else".
  // The hidden intake_narrative JSON still carries the whole shape either way, so
  // an omitted section is preserved (empty), never dropped.
  variant?: "full" | "light";
}) {
  const c = useNarrative(defaultValue);
  const full = variant !== "light";

  return (
    <div className="space-y-6">
      <NarrativeHiddenInput c={c} />

      {websiteForDraft !== undefined && (
        <WebsiteDraftButton
          url={websiteForDraft}
          onDraft={(d) =>
            c.patch({
              mission: d.mission || c.n.mission,
              funding_need: d.funding_need || c.n.funding_need,
            })
          }
        />
      )}

      <FundingNeedField c={c} required={fundingNeedRequired} />
      <MissionField c={c} />
      {full && <ProgramsSection c={c} />}
      <PriorityAreasSection c={c} />
      {full && (
        <>
          <PartnersSection c={c} />
          <AdditionalInfoField c={c} />
        </>
      )}
    </div>
  );
}
