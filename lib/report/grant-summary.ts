import { format, parseISO } from "date-fns";
import { computeEligibility, type EligibilityVerdict } from "@/lib/intellengine/eligibility";
import { readAllowableUses, type AllowableUses } from "@/lib/grants/allowable-uses";
import { awardRangeOrEstimate, compactCostShare, compactTerm } from "@/lib/grants/format";
import { deadlineDaysLeft, isOverdue } from "@/lib/report/shape";
import type { ReviewMeta } from "@/components/report/grant-review-console";
import type { Grant } from "@/types/database";

// The grant-SUMMARY props for the shared OverviewCard, built from a grant ALONE (no client).
// Used by the Ledger detail (/grants/[id]) and the prospect detail (/intel/[id]) so both render
// the grant summary identically to the grant report — one shared treatment, never a fork — even
// though neither page has a scored (grant, client) match to feed the report's rationale/fit cards.
//
// GRANT-LEVEL by construction:
//   · eligibility  — computeEligibility with clientOrgType/clientState null, so it reports a
//     "who can apply" read (eligible types + limits) rather than a per-client verdict. This is the
//     eligibility treatment on purpose (Shannon, PR-C): the callout still names the NOFO limits.
//   · tags         — focus areas only, all role:false. No role pill: there is no client here, so
//     nothing occupies a Prime/Partner seat.
//   · agencyLine   — funder · opportunity number, so the slimmed page header can drop it (the card
//     owns it, matching the report which has no separate title header).
export interface GrantSummaryProps {
  tags: { label: string; role: boolean }[];
  agencyLine: string | null;
  title: string;
  summary: string | null;
  meta: ReviewMeta[];
  eligibility: EligibilityVerdict;
  allowableUses: AllowableUses | null;
}

function fmtDeadline(raw: string | null | undefined): string {
  const s = (raw ?? "").trim();
  if (!s) return "Not stated";
  try {
    return format(parseISO(s), "MMM d, yyyy");
  } catch {
    return s;
  }
}

export function buildGrantSummary(grant: Grant): GrantSummaryProps {
  const days = deadlineDaysLeft(grant.submission_deadline);
  const overdue = isOverdue(days);

  // The same 5-tile facts strip the report builds (award range → deadline → match → term → awards),
  // via the same format helpers, so the tiles read identically across the report and these pages.
  const meta: ReviewMeta[] = [
    {
      // An inferred/estimated stored range must not read as a NOFO-stated figure (org rule: label award
      // amounts as estimates). `awardRangeOrEstimate` marks a POOL÷awards derivation ("est.") but returns a
      // populated stored min/max unchanged, so when that stored range is flagged an estimate we mark it on
      // the label (mirroring the retired GrantStatTiles "Award range · est."). Guarded on a real range so a
      // computed "~X est." value is never double-labelled.
      label:
        grant.award_range_is_estimate && (grant.award_range_min || grant.award_range_max)
          ? "Award range · est."
          : "Award range",
      value: awardRangeOrEstimate(grant.award_range_min, grant.award_range_max, grant.total_funding, grant.num_awards),
    },
    {
      label: "Deadline",
      value: fmtDeadline(grant.submission_deadline),
      // The one fact that can invalidate the page — a passed deadline fills the tile red.
      ...(overdue ? { tone: "danger" as const } : {}),
    },
    { label: "Match required", value: compactCostShare(grant.cost_share) },
    { label: "Term", value: compactTerm(grant.period_of_performance), full: grant.period_of_performance?.trim() || undefined },
    { label: "Awards expected", value: grant.num_awards?.trim() || "Not stated" },
  ];

  const eligibility = computeEligibility({
    eligibleEntityTypes: grant.eligible_entity_types,
    ineligibleEntities: grant.ineligible_entities,
    hardDisqualifiers: grant.hard_disqualifiers,
    skipReason: grant.skip_reason,
    geographicEligibility: grant.geographic_eligibility,
    // Grant-level: no client, so no per-client match/exclusion read.
    clientOrgType: null,
    clientState: null,
  });

  return {
    tags: (grant.focus_areas ?? []).filter((f) => f && f.trim()).map((label) => ({ label, role: false })),
    agencyLine: [grant.funder, grant.fon].filter(Boolean).join(" · ") || null,
    title: grant.title || "Untitled opportunity",
    // NULL, not grant.description: OverviewCard's ProgrammeSummary truncates at ~58 words with no expander
    // (fine for the client report, but it would hide material funding detail on a staff working page). Both
    // staff pages render the FULL, expandable description in a separate "What it funds" card below the
    // OverviewCard instead, so nothing is dropped and the opening lines are not shown twice.
    summary: null,
    meta,
    eligibility,
    allowableUses: readAllowableUses(grant.allowable_uses),
  };
}
