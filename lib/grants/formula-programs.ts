// CFDA / assistance-listing → "this is a FORMULA / ALLOCATION program" tag, handed to the IntellEngine
// QA reviewer so it knows to check APPLICATION eligibility (the allocation reality), not just the NOFO's
// ENTITY-TYPE list.
//
// WHY THIS EXISTS. The single error the QA pass is built to catch: for a formula / allocation program,
// "units of local government are eligible" (entity type) is NOT the same as "this jurisdiction can file
// a direct application" (application eligibility). The money flows by formula — through the State
// Administering Agency, the county, or an allocation table that marks disparate / "asterisk" units — so
// a genuine sub-recipient gets scored a confident direct-recipient by the engine. This tag marks the
// programs where that gap is STRUCTURAL, so QA reads the allocation source rather than trusting the
// entity-type list. It pairs with:
//   - allocation-sources.ts, the CFDA → authoritative-URL SEED map (a SUBSET: only programs we have a
//     known .gov allocation page for). This tag is the BROADER set — a program can be formula-tagged
//     with NO seeded URL, which is exactly the case web SEARCH (INTEL_WEB_SEARCH_ENABLED) exists to
//     cover: QA is told "this is formula, find the allocation table" and searches for it.
//
// DATA, NOT LOGIC — and CONSERVATIVE. Keyed only on the assistance-listing (CFDA) number, the reliable
// formula signal (program_type has no formula bucket, and a title keyword is noisy). Every entry is a
// program that is UNAMBIGUOUSLY formula / block / allocation-distributed at the federal level. It only
// ever ADDS a "verify the allocation reality" instruction to the QA prompt — it never demotes, suppresses,
// or scores anything (the QA pass is proposal-only, and its State-of-Arkansas AFFIRM eval case guards
// against over-demoting a genuine direct recipient). Grows one entry at a time as we confirm a program is
// formula-distributed, mirroring allocation-sources.ts.

export interface FormulaProgram {
  label: string;
  // One line on HOW the money actually flows, so the QA prompt can be specific about what to verify.
  allocationNote: string;
}

// Known federal FORMULA / BLOCK / ALLOCATION programs. Each is distributed by statutory formula (to
// states / units of local government / by an allocation table), so a sub-recipient is not a prime
// applicant even when the entity-type list reads as if it were. High-confidence entries only.
// Each note names BOTH sides of the formula structure — the DESIGNATED recipient that IS the direct/prime
// applicant (to AFFIRM) and the sub-participant that is not (to demote). The QA pass was over-demoting the
// designated recipient (e.g. a State Administering Agency) because the notes named only who was a sub;
// stating who the prime is gives the reviewer the affirmative anchor (case-2 over-demote fix).
export const FORMULA_PROGRAMS: Record<string, FormulaProgram> = {
  // Edward Byrne Memorial Justice Assistance Grant (JAG) — Local. Local allocation table marks
  // disparate / asterisk jurisdictions that must apply jointly / through the county / via the state.
  "16.738": {
    label: "Edward Byrne Memorial Justice Assistance Grant (JAG)",
    allocationNote:
      "Distributed by the JAG allocation formula. The State Administering Agency, and any local jurisdiction that holds its OWN direct allocation on the table, ARE direct applicants; a disparate / 'asterisk' local jurisdiction with no direct allocation cannot prime and must apply jointly, through the county, or via the State Administering Agency.",
  },
  // Crime Victim Assistance (VOCA). Formula grant to STATES; local victim-services organizations are
  // SUBGRANTEES through the state VOCA administering agency, not direct/prime applicants.
  "16.575": {
    label: "Crime Victim Assistance (VOCA Victim Assistance Formula)",
    allocationNote:
      "A formula grant to the states: the Governor-designated state VOCA administering agency IS the direct applicant; local and nonprofit victim-services providers participate as SUBGRANTEES through that agency, not as direct federal applicants.",
  },
  // STOP Violence Against Women Formula Grants. Formula to states; local governments and nonprofits
  // are subgrantees through the state STOP administering agency.
  "16.588": {
    label: "Violence Against Women Formula Grants (STOP)",
    allocationNote:
      "A formula grant to the states: the state STOP administering agency IS the direct applicant; local governments and nonprofits participate as subgrantees through that agency, not as direct applicants.",
  },
  // Community Development Block Grant — Entitlement communities. Formula/allocation to entitlement
  // jurisdictions; a non-entitlement locality participates through the state CDBG program.
  "14.218": {
    label: "Community Development Block Grant (CDBG) — Entitlement",
    allocationNote:
      "A formula/allocation program: an entitlement jurisdiction receives its OWN direct allocation and applies directly to HUD; a non-entitlement locality participates through the state CDBG program, not as a direct HUD applicant.",
  },
  // Community Development Block Grant — State's program (small cities). Formula to states, which then
  // subaward to non-entitlement local governments.
  "14.228": {
    label: "Community Development Block Grant (CDBG) — State's Program",
    allocationNote:
      "A formula grant to the states: the state IS the direct HUD applicant; non-entitlement local governments receive funds as subrecipients of the state, not as direct HUD applicants.",
  },
  // Federal Transit Formula Grants (§5307 and related). Apportioned by formula to designated
  // recipients / urbanized areas; other operators participate as subrecipients of that recipient.
  "20.507": {
    label: "Federal Transit Formula Grants",
    allocationNote:
      "Apportioned by formula to the DESIGNATED RECIPIENT for each urbanized area, which IS the direct applicant; other transit operators participate as subrecipients of that designated recipient, not as direct FTA applicants.",
  },
  // Title I Grants to Local Educational Agencies. Formula through the State Educational Agency to LEAs.
  "84.010": {
    label: "Title I Grants to Local Educational Agencies",
    allocationNote:
      "A formula program: the State Educational Agency is the direct recipient and sub-allocates to LEAs by formula; it is not a competitive direct application.",
  },
  // Special Education — IDEA Part B Grants to States. Formula through the state to LEAs.
  "84.027": {
    label: "Special Education — Grants to States (IDEA Part B)",
    allocationNote:
      "A formula grant to the states: the State Educational Agency is the direct recipient, sub-allocated to LEAs by formula; not a competitive direct application.",
  },
};

// Normalize an assistance-listing number to the map key: strip a trailing letter suffix (e.g. "16.738A"
// → "16.738") and surrounding whitespace. Non-CFDA-shaped strings pass through trimmed and won't match.
function normalizeCfda(raw: string): string {
  return raw.trim().replace(/[A-Za-z]$/, "");
}

export interface FormulaTag {
  isFormula: boolean;
  // The matched CFDA + program, when a listing is a known formula program. Null when none match.
  cfda: string | null;
  program: FormulaProgram | null;
}

// Classify a grant (by its assistance listings) as a known formula/allocation program. Returns the FIRST
// matching listing. Empty/unknown listings → { isFormula:false }, which is the common case and correct:
// the QA pass then verifies against the NOFO's own eligibility read as it does today.
export function formulaProgramTag(
  assistanceListings: { number?: string | null }[] | null | undefined,
): FormulaTag {
  for (const a of assistanceListings ?? []) {
    const num = a?.number ? normalizeCfda(a.number) : "";
    if (!num) continue;
    const program = FORMULA_PROGRAMS[num];
    if (program) return { isFormula: true, cfda: num, program };
  }
  return { isFormula: false, cfda: null, program: null };
}
