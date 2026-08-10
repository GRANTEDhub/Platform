// Turning an extraction into field-level PROPOSED profile changes.
//
// PURE and dependency-free, so the rule that matters can be tested directly rather than
// inferred from a route's behaviour. No server-only import: the review UI renders from the
// same functions the commit path validates with, so the screen and the write can never
// disagree about what was proposed.
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
