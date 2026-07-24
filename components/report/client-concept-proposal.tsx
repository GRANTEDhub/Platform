import { Card } from "@/components/ui/card";
import { SectionTitle } from "./primitives";
import { ConceptProposalView } from "./concept-proposal-view";
import type { ConceptProposalRow } from "@/types/database";

// Client-facing, read-only concept proposal on the portal grant detail (premium /
// account-managed clients only). The account manager generates, reviews, edits,
// and releases the grant; by the time the client reaches this, it's the team's
// finalized version -- so no actions here (editing stays with GRANTED / IntellEngine
// later) and no provenance tags. Fetched server-side via the service role in the
// page (concept_proposals is admin-only RLS); the page has already confirmed the
// card belongs to this client and is released.
export function ClientConceptProposal({ row }: { row: ConceptProposalRow | null }) {
  if (!row) return null;

  if (row.status === "ready" && row.proposal_data) {
    return (
      <Card elevation="grounded" className="p-6 sm:p-7">
        <SectionTitle>Concept proposal</SectionTitle>
        <p className="mt-1.5 text-[12.5px] text-muted-foreground">
          How your GRANTED team scoped a run at this grant — a starting point to react to, not a final application.
        </p>
        <div className="mt-4">
          <ConceptProposalView proposal={row.proposal_data} showSourceTags={false} />
        </div>
      </Card>
    );
  }

  if (row.status === "generating") {
    return (
      <Card elevation="grounded" className="p-6 sm:p-7">
        <SectionTitle>Concept proposal</SectionTitle>
        <p className="mt-1.5 text-[12.5px] text-muted-foreground">
          Your GRANTED team is preparing a concept proposal for this grant. Check back shortly.
        </p>
      </Card>
    );
  }

  // Anything else (error / no data) isn't surfaced to the client.
  return null;
}
