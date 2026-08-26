// Low-award-count pre-filter — a CLIENT-CONDITIONAL, forward-only, flag-gated skip.
//
// Rule: a grant expecting FEWER THAN 10 awards is a hard-skip (suppressed, not surfaced)
// for a client UNLESS that client is a state government or an institution of higher
// education. State agencies and universities realistically compete for low-award national
// programs; counties, cities, small businesses, and nonprofits mostly cannot, so those
// programs only clutter their reports with grants they cannot win.
//
// WHY CLIENT-CONDITIONAL, AND WHY IT LIVES AT THE PER-CLIENT SEAM: the same grant must skip
// for a county but survive for a state-gov / IHE client, so the check needs the client's
// org_type at gate time. It is called from jsPreFilter (engine.ts), the per-client pre-filter,
// AFTER the grant-level `grantLevelSuppressionReason` (single national award / TTA <=10 slots),
// which has no client and kills a grant for EVERYONE. This is an ADDED general <10-award gate,
// NOT a replacement: those two grant-level rules still run first, so a 1-award national or a
// TTA <=10 grant stays killed for everyone. This carve-out therefore only ever rescues the
// 2-9 award band -- the band where a state agency / university genuinely could compete.
//
// FAIL OPEN ON EVERY MISSING INPUT. num_awards is frequently empty (the Simpler API omits
// expected_number_of_awards for most grants), and org_type is free text and nullable. We NEVER
// skip on missing/uncertain data: a skip requires a REAL integer count < 10 AND a KNOWN,
// non-carve-out org_type. A null/empty/non-numeric count, or a null/empty/legacy-unrecognized
// org_type, surfaces. Mirrors grantLevelSuppressionReason's own `|| "999"` fail-open convention.
//
// Flag OFF (MATCH_LOW_AWARD_GATE_ENABLED unset / != "true") is IDENTITY: returns null with no
// other effect, so jsPreFilter behaves byte-for-byte as today -- the instant kill-switch, same
// discipline as the mission / generic-nexus / calibration gates. Deterministic (no model call),
// so a unit test fully covers it; no model-in-the-loop eval is needed to flip the flag.

import type { ExtractedGrant } from "@/lib/grants/engine";
import type { Client } from "@/types/database";
import { ORG_TYPES } from "@/lib/clients/org-types";

const FLAG = "MATCH_LOW_AWARD_GATE_ENABLED";
const LOW_AWARD_THRESHOLD = 10; // "fewer than 10" -> 10 itself is NOT low, and surfaces.

// org_type values (lib/clients/org-types.ts, stored verbatim) that STILL SURFACE a low-award
// grant. `higher_education` is flat -- community colleges are included, no sub-distinction.
const SURFACES_LOW_AWARD = new Set<string>(["state_government", "higher_education"]);

/**
 * Returns a suppression reason (skip this grant for this client, do not surface) or null
 * (surface normally). Deterministic; no side effects; no model call.
 */
export function lowAwardSkipReason(
  extracted: ExtractedGrant,
  client: Client,
): string | null {
  if (process.env[FLAG] !== "true") return null; // OFF = identity (byte-for-byte as today)

  // Fail open on a missing / non-numeric count -- never skip on unknown award data.
  const numAwards = parseInt(extracted.num_awards || "", 10);
  if (isNaN(numAwards)) return null;
  if (numAwards >= LOW_AWARD_THRESHOLD) return null; // enough awards -> surface

  // Skip ONLY for a KNOWN org_type that is not in the carve-out. A null / empty /
  // legacy-unrecognized org_type falls through to surface -- never skip on missing or
  // uncertain client data. Keying on ORG_TYPES membership (not a hardcoded blocklist) means
  // a future org_type added there is gated by default, while unknown/legacy values stay safe.
  const orgType = client.org_type ?? "";
  const known = (ORG_TYPES as readonly string[]).includes(orgType);
  if (!known || SURFACES_LOW_AWARD.has(orgType)) return null;

  return (
    `Low award count (${numAwards} expected, < ${LOW_AWARD_THRESHOLD}) -- not surfaced for ` +
    `org_type "${orgType}"; low-award programs surface only for state government / higher education.`
  );
}
