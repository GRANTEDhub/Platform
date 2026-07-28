// Prepopulation for the IntellEngine scope step.
//
// PURE (no I/O) so it's client-safe to import for the ScopeSeed type and testable
// in isolation. The server page resolves the concept proposal + grant (context.ts,
// service-role) and calls this to build the small, serializable seed passed to the
// scope editor -- the full Grant/Client rows never cross to the client bundle.
//
// Precedence: a released concept proposal (the version the GRANTED team already
// scoped for this client + grant) > light grant-derived hints > blank (from
// scratch). Replaces the old hardcoded mobile-health-clinic mock in scope-client.

import type { ConceptProposal, Grant } from "@/types/database";

export interface SeedPartner {
  name: string;
  role: string;
  description: string;
}

export interface ScopeSeed {
  scope: string;
  role: "prime" | "partner";
  budget: string;
  partners: SeedPartner[];
  // Where the seed came from -- drives the one-line origin note in the editor.
  origin: "concept" | "grant" | "scratch";
}

const EMPTY: ScopeSeed = { scope: "", role: "prime", budget: "", partners: [], origin: "scratch" };

export function scopeSeedFrom(concept: ConceptProposal | null, grant: Grant | null): ScopeSeed {
  if (concept) {
    return {
      scope: concept.scope ?? "",
      role: concept.role === "partner" ? "partner" : "prime",
      budget: concept.total_project_amount ?? "",
      partners: (concept.partners ?? []).map((p) => ({
        // A named org when we have one, otherwise the org-type label ("workforce
        // partner"); the editor shows "Unnamed partner" if both are blank.
        name: (p.name || p.org_type_label || "").trim(),
        role: (p.role || "").trim(),
        description: (p.description || "").trim(),
      })),
      origin: "concept",
    };
  }

  if (grant) {
    const budget = [grant.award_range_min, grant.award_range_max]
      .map((v) => (v && v.trim() ? v.trim() : null))
      .filter(Boolean)
      .join(" - ");
    // No concept yet: start the client from a blank scope (theirs to write) with
    // only the grant's award range as an estimate hint. Nothing invented.
    return { scope: "", role: "prime", budget, partners: [], origin: "grant" };
  }

  return EMPTY;
}
