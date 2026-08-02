// Per-client NOFO eligibility read for the IntellEngine compliance step.
//
// PURE + deterministic (no I/O, no LLM) so it's testable and safe to run at page
// render. It surfaces the NOFO's own eligibility facts alongside a conservative,
// per-client read -- it NEVER blocks the flow. That posture is deliberate: the
// blunt `hard_disqualifiers`-presence block (old PR #24) buried eligible
// nonprofits because the extraction mis-files per-applicant exclusions ("for-profit
// entities ineligible") into all-client disqualifiers a nonprofit would pass. So
// here: uncertain -> "confirm with your GRANTED team" (amber), never a red block;
// a disqualifier list is shown as something to check, not treated as ineligibility.
//
// This is intentionally NOT the matcher. Occupancy/seat logic lives in the engine
// (a protected file); this is a lightweight, display-only eligibility summary for
// the client, grounded in the same NOFO fields the matcher reads.

export interface EligibilityInput {
  eligibleEntityTypes: string[] | null;
  ineligibleEntities: string | null;
  hardDisqualifiers: string[] | null;
  skipReason: string | null;
  geographicEligibility: string | null;
  clientOrgType: string | null;
  clientState: string | null;
}

export type EligibilityLevel = "eligible" | "caution" | "ineligible" | "unknown";

export interface EligibilityVerdict {
  level: EligibilityLevel;
  headline: string;
  reasons: string[];
  // WHICH eligible-entity-type string the client matched, verbatim from the NOFO. Null
  // when nothing matched or there was nothing to match against. The staff review screen
  // names it ("qualifies as a domestic private nonprofit entity") — a verdict that cannot
  // say what it qualifies UNDER is not a verdict, it is a colour.
  matchedType: string | null;
  // NOFO facts, surfaced verbatim for the client to read.
  eligibleTypes: string[];
  excluded: string | null;
  geographic: string | null;
  // A genuine all-client structural limitation (single national award / TTA etc.).
  structuralNote: string | null;
}

// Keyword fingerprints for the common GRANTED client org types. Matching is done
// on the NOFO's free-text entity-type strings, which phrase the same category many
// ways ("Nonprofits having a 501(c)(3) status", "County governments", "Public and
// State controlled institutions of higher education"). Conservative on purpose: a
// miss lands in "confirm", never a false green or a false block.
const ORG_TYPE_KEYWORDS: { test: RegExp; keywords: string[] }[] = [
  { test: /non[- ]?profit|501\s*\(?c\)?|not[- ]for[- ]profit|charit/i, keywords: ["nonprofit", "non-profit", "not-for-profit", "501(c)", "501c", "charit"] },
  { test: /\bcounty\b/i, keywords: ["county"] },
  { test: /\bcity\b|municipal|township/i, keywords: ["city", "municipal", "township", "local government"] },
  { test: /\bstate\b/i, keywords: ["state government", "state agency", "state-controlled"] },
  { test: /transit|transportation/i, keywords: ["transit", "public transportation", "transportation authority"] },
  { test: /college|universit|higher ed/i, keywords: ["college", "universit", "higher education", "institution of higher", "ihe"] },
  { test: /school district|\blea\b|k-?12|educational agency/i, keywords: ["school district", "local educational", "local education agency", "k-12"] },
  { test: /hospital|health system|health ?care/i, keywords: ["hospital", "health system", "health care", "healthcare"] },
  { test: /tribal|tribe|native american|\bindian\b/i, keywords: ["tribal", "tribe", "native american", "indian"] },
];

// Turn a free-text client org type into the keywords to hunt for in the NOFO's
// entity-type text. Falls back to the org type's own significant words so an
// unmapped type still gets a best-effort direct match.
function keywordsForOrgType(orgType: string): string[] {
  const hits = ORG_TYPE_KEYWORDS.filter((m) => m.test.test(orgType)).flatMap((m) => m.keywords);
  if (hits.length) return hits;
  return orgType
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length > 3 && !["organization", "government", "agency", "public"].includes(w));
}

function textMatches(haystack: string, keywords: string[]): boolean {
  const h = haystack.toLowerCase();
  return keywords.some((k) => h.includes(k.toLowerCase()));
}

export function computeEligibility(input: EligibilityInput): EligibilityVerdict {
  const eligibleTypes = (input.eligibleEntityTypes ?? []).filter((t) => t && t.trim());
  const excluded = input.ineligibleEntities?.trim() || null;
  const geographic = input.geographicEligibility?.trim() || null;
  const structuralNote = input.skipReason?.trim() || null;
  const orgType = input.clientOrgType?.trim() || null;
  const disqualifiers = (input.hardDisqualifiers ?? []).filter((d) => d && d.trim());

  const reasons: string[] = [];
  let level: EligibilityLevel = "unknown";
  let headline = "Your GRANTED team will confirm eligibility for this opportunity.";

  const keywords = orgType ? keywordsForOrgType(orgType) : [];
  const eligibleText = eligibleTypes.join(" | ");
  // Matched per-entry rather than against the joined text, so the verdict can name the
  // specific clause rather than the whole list.
  const matchedType = keywords.length ? eligibleTypes.find((t) => textMatches(t, keywords)) ?? null : null;

  // A genuine all-client structural limitation is the strongest signal. Rare in
  // IntellEngine (matched cards on skip_reason grants are suppressed upstream), so
  // surface it plainly but still never block.
  if (structuralNote) {
    level = "ineligible";
    headline = "This opportunity has a structural limitation to review before you invest time.";
    reasons.push(`Structural limitation on file: ${structuralNote}`);
  }

  // Explicit exclusion that appears to name the client's category.
  if (excluded && orgType && keywords.length && textMatches(excluded, keywords)) {
    if (level !== "ineligible") {
      level = "caution";
      headline = "Confirm your eligibility with your GRANTED team before proceeding.";
    }
    reasons.push(`The NOFO names an excluded category that may apply to a ${orgType}: "${excluded}". Confirm this does not rule you out.`);
  }

  // Positive entity-type read.
  if (eligibleTypes.length && orgType) {
    if (textMatches(eligibleText, keywords)) {
      if (level === "unknown") {
        level = "eligible";
        headline = `A ${orgType} appears eligible to apply for this opportunity.`;
      }
    } else if (level === "unknown") {
      level = "caution";
      headline = "Confirm your eligibility with your GRANTED team.";
      reasons.push(`A ${orgType} was not an obvious match to the stated eligible entity types. This is common when a NOFO phrases eligibility differently than your org type; your GRANTED team will confirm.`);
    }
  } else if (eligibleTypes.length && !orgType && level === "unknown") {
    level = "unknown";
    headline = "Review the eligible entity types below with your GRANTED team.";
  }

  // Disqualifier conditions: shown as things to check, NEVER as an automatic block
  // (see the PR #24 lesson at the top). Only nudges an otherwise-clear read to a
  // soft caution.
  if (disqualifiers.length) {
    reasons.push(
      `The NOFO lists disqualifying conditions to confirm none apply to your organization: ${disqualifiers.join("; ")}.`,
    );
    if (level === "eligible") level = "caution";
  }

  return { level, headline, reasons, matchedType, eligibleTypes, excluded, geographic, structuralNote };
}
