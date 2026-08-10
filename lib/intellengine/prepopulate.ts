// Prepopulation for the IntellEngine scope step.
//
// PURE (no I/O) so it's client-safe to import for the ScopeSeed type and testable
// in isolation. The server page resolves the concept proposal + grant (context.ts,
// service-role) and calls this to build the small, serializable seed passed to the
// scope editor -- the full Grant/Client rows never cross to the client bundle.
//
// Precedence: THE CLIENT'S OWN SAVED SCOPE > a released concept proposal (the version
// the GRANTED team already scoped for this client + grant) > light grant-derived hints >
// blank (from scratch). Replaces the old hardcoded mobile-health-clinic mock in
// scope-client.
//
// SAVED WINS ON PRESENCE, NOT ON TRUTHINESS. The test is scope.savedAt, never whether the
// stored text is non-empty: a client who deliberately cleared the box has to find it clear
// when they come back, and re-seeding from the concept proposal would hand them back words
// they deleted. See DraftScope.savedAt in content.ts.

import type { ConceptProposal, Grant } from "@/types/database";
import type { DraftScope } from "@/lib/intellengine/content";

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
  // Free-text the client adds for the drafter. Only ever comes from a saved scope -- there
  // is nothing in a concept proposal or a grant that honestly prefills it.
  notes: string;
  // Where the seed came from -- drives the one-line origin note in the editor. "saved" is
  // what stops that note claiming "prepopulated from the concept proposal" over the
  // client's own edits.
  origin: "saved" | "concept" | "grant" | "scratch";
}

const EMPTY: ScopeSeed = { scope: "", role: "prime", budget: "", partners: [], notes: "", origin: "scratch" };

export function scopeSeedFrom(
  concept: ConceptProposal | null,
  grant: Grant | null,
  saved?: DraftScope | null,
): ScopeSeed {
  // FIRST, and on savedAt rather than on content: everything below is a prefill, and a
  // prefill must never overwrite what the client actually wrote (or deleted).
  if (saved?.savedAt) {
    return {
      scope: saved.scope,
      role: saved.role,
      budget: saved.budget,
      partners: saved.partners.map((p) => ({ name: p.name, role: p.role, description: p.description })),
      notes: saved.notes,
      origin: "saved",
    };
  }

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
      notes: "",
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
    return { scope: "", role: "prime", budget, partners: [], notes: "", origin: "grant" };
  }

  return EMPTY;
}
