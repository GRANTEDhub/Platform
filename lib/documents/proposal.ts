// Turning an extraction into field-level PROPOSED profile changes.
//
// PURE -- no I/O, no server-only import, and its one import (ORG_TYPES) is a frozen constant
// list. That matters because the review UI renders from the same functions the commit path
// validates with, so the screen and the write can never disagree about what was proposed, and
// the whole module can be exercised directly in a test.
//
// ── THE PROPERTY THAT MAKES THIS SAFE ──
//
// A proposal can only touch fields A CLIENT COULD ALREADY TYPE BY HAND -- exactly the set
// confirmClientProfileAction writes. So the worst case for a bad extraction is that it
// writes something a client could have typed themselves. It cannot reach engagement_tier,
// retainer_hours, match_config, or anything financial. `ein` and `annual_budget` are
// extractable from a 990 and are deliberately NOT here: automating typing must not quietly
// become "documents can set financial fields". Widening this list is a decision, not a
// side effect, which is why it is one array in one place.

import { ORG_TYPES } from "@/lib/clients/org-types";

// Direct columns on `clients`.
const DIRECT_FIELDS = [
  "org_type",
  "primary_contact_name",
  "primary_contact_email",
  "primary_contact_phone",
  "website",
  "location_street",
  "location_city",
  "location_county",
  "location_state",
  "location_zip",
  "primary_funding_needs",
] as const;

// Keys inside `clients.intake_data`, addressed as "intake_data.<key>" so a field name is
// unambiguous in the audit log.
const INTAKE_KEYS = [
  "funding_need",
  "priority_areas",
  "mission",
  "programs",
  "partners",
  "partnerships",
  "additional_info",
] as const;

export const PROPOSABLE_FIELDS: readonly string[] = [
  ...DIRECT_FIELDS,
  ...INTAKE_KEYS.map((k) => `intake_data.${k}`),
];

export function isProposableField(field: unknown): field is string {
  return typeof field === "string" && PROPOSABLE_FIELDS.includes(field);
}

// ── THE TWO FIELDS THAT CARRY EXTRA RULES, AND WHY THEY ARE ENFORCED HERE ──
//
// confirmClientProfileAction treats org_type and primary_funding_needs as ADDITIVE-ONLY --
// an empty submit never clears them, because both are staff-set and load-bearing -- and it
// validates org_type against ORG_TYPES rather than storing free text. The PR that introduced
// assimilation claimed to EXTEND that rule; review on #340 found the claim was not true of
// the commit path, only of buildProposals, so a crafted request could clear org_type or set
// it to arbitrary text. That is worse than an ordinary gap: it is an invariant we said we
// were upholding.
//
// org_type is load-bearing in a specific way worth naming: migration 0065 keyed the
// first-login verification exemption on it, so clearing it silently re-arms the /welcome gate
// for that client.
//
// Kept in this module, beside the allowlist, so the screen and the writer read the same rule
// from the same place -- and exported so the writer can enforce it rather than trusting that
// the proposal builder already did.
const ADDITIVE_ONLY_FIELDS: readonly string[] = ["org_type", "primary_funding_needs"];

export type FieldRejection = "would_clear_protected_field" | "org_type_not_recognised";

// Proposing NEW content is a different act from RESTORING a value the profile already held,
// and these rules only make sense for the first.
//
// Review finding on #340, and a regression I introduced with the rules themselves: rolling
// back a commit that FILLED org_type from empty means writing the empty value back, which
// "would_clear_protected_field" then refused -- so the rollback silently restored nothing and
// still reported success. The commit.ts comment beside the rollback call had already stated the
// exception ("the one place a commit is allowed to write an empty value -- restoring a blank a
// human is explicitly asking to restore"); the guard I added one commit later did not
// implement it. Third instance of the same blind spot on this brick, so it is stated in the
// signature now rather than in prose: the caller must SAY which act this is.
//
// A rollback also bypasses the ORG_TYPES check, deliberately. old_value is a value the profile
// genuinely held, so refusing to restore it would strand the client in the state they are
// trying to leave -- and an unrecognised value that got in by some other path is not made
// safer by making it unreversible.
export type CommitIntent = "proposal" | "rollback";

// Why this value may not be written, or null if it may. Pure, so both paths can ask.
export function rejectValue(
  field: string,
  value: unknown,
  intent: CommitIntent = "proposal",
): FieldRejection | null {
  if (intent === "rollback") return null;
  if (ADDITIVE_ONLY_FIELDS.includes(field) && isEmptyValue(value)) {
    return "would_clear_protected_field";
  }
  if (field === "org_type" && !(ORG_TYPES as readonly string[]).includes(String(value))) {
    return "org_type_not_recognised";
  }
  return null;
}

export const FIELD_LABEL: Record<string, string> = {
  org_type: "Organization type",
  primary_contact_name: "Contact name",
  primary_contact_email: "Contact email",
  primary_contact_phone: "Phone",
  website: "Website",
  location_street: "Street",
  location_city: "City",
  location_county: "County",
  location_state: "State",
  location_zip: "ZIP",
  primary_funding_needs: "Priority areas (matcher)",
  "intake_data.funding_need": "What you need funded",
  "intake_data.priority_areas": "Priority areas",
  "intake_data.mission": "Mission",
  "intake_data.programs": "Programs",
  "intake_data.partners": "Partners",
  "intake_data.partnerships": "Partnerships (text)",
  "intake_data.additional_info": "Additional notes",
};

export interface FieldProposal {
  field: string;
  label: string;
  currentValue: unknown;
  proposedValue: unknown;
  // True when the profile field holds nothing today. Drives the default below and lets the
  // UI say "filling a gap" rather than "replacing".
  isFill: boolean;
  // THE ASYMMETRIC DEFAULT. Pre-checked when this FILLS an empty field; unchecked when it
  // would OVERWRITE existing content.
  //
  // Filling a blank is cheap and visible, and making a reviewer tick twelve boxes to accept
  // an obviously-good extraction is how review decays into rubber-stamping. Overwriting a
  // human's own words is the expensive direction, so it takes a deliberate click and is
  // shown side by side.
  //
  // This extends a rule already in the codebase rather than inventing one:
  // confirmClientProfileAction treats primary_funding_needs and org_type as additive-only,
  // never clearing them on an empty submit, for the same reason.
  defaultAccepted: boolean;
}

// Empty means empty for every shape this set carries: null/undefined, blank-or-whitespace
// text, and an empty array. `partners`/`programs` are arrays of objects, so a length check
// is what "has content" means for them.
export function isEmptyValue(v: unknown): boolean {
  if (v === null || v === undefined) return true;
  if (typeof v === "string") return v.trim() === "";
  if (Array.isArray(v)) return v.length === 0;
  if (typeof v === "object") return Object.keys(v as object).length === 0;
  return false;
}

// Read a proposable field's current value off a client row.
export function readCurrentValue(field: string, client: Record<string, unknown>): unknown {
  if (field.startsWith("intake_data.")) {
    const intake = client.intake_data;
    if (!intake || typeof intake !== "object") return null;
    return (intake as Record<string, unknown>)[field.slice("intake_data.".length)] ?? null;
  }
  return client[field] ?? null;
}

// Values that are equal after normalisation propose nothing. Without this, re-running an
// extraction against an already-committed profile would offer a screenful of "changes"
// that change nothing, and a reviewer who accepted them would fill the audit log with
// no-ops -- making the log harder to read for the one case it exists to serve.
export function valuesEqual(a: unknown, b: unknown): boolean {
  if (typeof a === "string" && typeof b === "string") return a.trim() === b.trim();
  return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
}

// Build the review list from an extraction and the client's current row.
//
// Order is PROPOSABLE_FIELDS order, not extraction order, so the same document always
// reviews the same way -- an LLM's key order is not a stable thing to render from.
export function buildProposals(
  extractedFields: Record<string, unknown> | null | undefined,
  client: Record<string, unknown>,
): FieldProposal[] {
  const fields = extractedFields ?? {};
  const out: FieldProposal[] = [];
  for (const field of PROPOSABLE_FIELDS) {
    if (!(field in fields)) continue;
    const proposedValue = fields[field];
    // An extractor that found nothing must omit the key; a present-but-empty value would
    // otherwise propose CLEARING a field, which no document ever justifies.
    if (isEmptyValue(proposedValue)) continue;
    const currentValue = readCurrentValue(field, client);
    if (valuesEqual(currentValue, proposedValue)) continue;
    // NEVER OFFER WHAT THE WRITER WILL REFUSE. An extractor can plausibly return "501c3
    // nonprofit" for org_type, which is not in ORG_TYPES -- rendering it would invite a
    // reviewer to tick something that then silently does not save.
    if (rejectValue(field, proposedValue)) continue;
    const isFill = isEmptyValue(currentValue);
    out.push({
      field,
      label: FIELD_LABEL[field] ?? field,
      currentValue,
      proposedValue,
      isFill,
      defaultAccepted: isFill,
    });
  }
  return out;
}
