import { describe, it, expect } from "vitest";
import { generateFitNarrative, type FitCard, type FitGrant } from "./fit-analysis";
import { FORBIDDEN_NARRATIVE_MARKERS } from "./fit-narrative";
import type { ProgramAwardSummary } from "./program-awards";
import type { Client } from "@/types/database";

// ── Fit-analysis narrative eval — the FLIP GATE for FIT_ANALYSIS_ENABLED ─────────────────────────────
//
// MODEL-IN-THE-LOOP. NOT a unit test; MUST NOT run in the normal suite or the sandbox — it makes real
// (paid) Opus calls. Skipped unless RUN_FIT_ANALYSIS_EVAL=1 AND ANTHROPIC_API_KEY is present:
//
//   RUN_FIT_ANALYSIS_EVAL=1 FIT_ANALYSIS_EVAL_RUNS=3 ANTHROPIC_API_KEY=... \
//   npx vitest run lib/grants/fit-analysis.eval.test.ts
//
// WHY THIS IS THE REAL DELIVERABLE. The whole point of the overhaul is that the MODEL produces a genuinely
// good, honest "why this client fits" paragraph — reliably, across the range of cards. The plumbing
// (freshness, the non-scorer write lock, the award reducer, the guard) is unit-tested deterministically in
// fit-analysis.test.ts; this eval owns the part only a live model can prove:
//   - it builds the fit case across the axes (eligibility, mission↔funds, role) instead of mail-merge filler;
//   - award history stays STATE-PRESENCE ONLY — never a by-applicant-type claim (the compliance guardrail);
//   - a CONDITIONAL (fit-2) card names its real hurdle honestly (no oversell);
//   - a SPARSE-DATA client gets a SHORTER honest note, not padded filler — the exact failure this overhaul kills;
//   - it stays CLIENT-SAFE: no scoring machinery, no seat codes, no numeric score, no "Go/No-go" opener.
//
// The fixtures are SYNTHETIC (constructed here), so there is no prod-DB dependency; the only external
// dependency is Anthropic. generateFitNarrative runs the SAME narrativeGuard the drain uses, so a returned
// non-empty string is already machinery-clean and code-stripped; a run the guard nulled comes back "" and
// fails the "mostly non-empty" bar — which is itself the signal that the raw output leaked.

const RUN = process.env.RUN_FIT_ANALYSIS_EVAL === "1" && !!process.env.ANTHROPIC_API_KEY;
const RUNS = Math.max(1, Number(process.env.FIT_ANALYSIS_EVAL_RUNS) || 3);
// Each case makes RUNS sequential live Opus calls (~10-30s each), far over vitest's 5s default per-test
// timeout — so each `it` needs its own generous timeout or it fails on the clock, not the content. Bounded
// by the workflow's own timeout-minutes. Scales with RUNS so a higher sample count doesn't clip.
const EVAL_TIMEOUT_MS = Math.max(120_000, RUNS * 90_000);

// Markers of a by-applicant-TYPE claim — the one thing the state-presence award rule forbids. The names are
// never even in the prompt (reduceAwardHistory drops them), so this should be impossible; the eval proves it.
const BY_TYPE_AWARD_MARKERS = [
  "usually go", "typically go", "tend to go", "no county", "no city", "no municipalit",
  "counties win", "cities win", "universities win", "often awarded to", "most awards go",
];

const clientOf = (over: Partial<Client> = {}): Client =>
  ({
    id: "c1",
    name: "Northwest Arkansas Community College",
    org_type: "higher_education",
    location_city: "Bentonville",
    location_state: "AR",
    service_area: ["Benton County", "Washington County"],
    primary_funding_needs: ["workforce development"],
    match_active: true,
    client_profile: {
      summary: "A two-year community college serving Northwest Arkansas.",
      mission: "Expand affordable workforce and career-and-technical education across Northwest Arkansas.",
      funding_priorities: ["workforce development", "career and technical education", "student support"],
      core_capabilities: ["career and technical education", "adult education", "employer partnerships"],
    },
    ...over,
  }) as unknown as Client;

// The full NOFO carries decision-driving specifics the ONE-LINE brief does NOT: a 25% non-federal match,
// a rural / persistent-poverty competitive priority, and a Title IV + existing-CTE eligibility gate. A
// narrative that surfaces any of these proves it read the DOCUMENT, not the summary — the whole point of
// Phase 1 (Shannon's "reads like a NOFO analysis, not a longer brief" bar). Kept realistic but compact.
const SCCWP_NOFO = `NOTICE OF FUNDING OPPORTUNITY — Strengthening Community College Workforce Pipelines (SCCWP)

A. Program Description. The Department funds accredited two-year and technical colleges to design and scale employer-aligned training leading to industry-recognized, STACKABLE credentials in high-demand sectors (advanced manufacturing, healthcare, IT, clean energy). Funded activities include curriculum development, work-based learning and REGISTERED APPRENTICESHIP, training-lab equipment, and student wraparound supports.

B. Eligibility. Eligible applicants are institutions of higher education that are TITLE IV-eligible and hold current regional or national accreditation. An applicant must operate an EXISTING career and technical education (CTE) program in at least one funded sector at the time of application; an institution without a current CTE program is not eligible to apply as the lead.

C. Cost Sharing / Matching. This program requires a NON-FEDERAL MATCH of 25% of total project costs. Match may be cash or documented third-party in-kind; in-kind employer contributions (equipment, instructor time) are encouraged and count toward the match.

D. Competitive Priorities. Applications receive competitive preference points for: (1) projects that primarily serve RURAL communities or areas of PERSISTENT POVERTY (a 20%+ poverty rate over the last 30 years); and (2) a signed commitment from at least one employer partner and the local Workforce Development Board.

E. Award Information. The Department expects approximately 40 awards from $500,000 to $3,000,000 over a four-year period of performance.

F. Deadline & Registration. Applications are due January 15, 2027 via Grants.gov; applicants must hold an active SAM.gov registration at submission.`;

const grantOf = (over: Partial<FitGrant & { program_award_summary: ProgramAwardSummary | null }> = {}) =>
  ({
    title: "Strengthening Community College Workforce Pipelines",
    funder: "U.S. Department of Labor",
    // The one-line brief stays deliberately generic — the match, the rural/poverty priority, and the
    // Title IV/existing-CTE gate are ONLY in raw_text, so surfacing them is proof of a real NOFO read.
    description_brief:
      "Funds community and technical colleges to build employer-aligned workforce training programs in high-demand sectors, in partnership with local employers and workforce boards.",
    description: null,
    raw_text: SCCWP_NOFO,
    eligible_entity_types: ["higher_education", "community_college"],
    program_type: "discretionary",
    geographic_eligibility: "National",
    submission_deadline: "2027-01-15",
    program_award_summary: null,
    ...over,
  }) as FitGrant & { program_award_summary: ProgramAwardSummary | null };

const cardOf = (over: Partial<FitCard> = {}): FitCard => ({
  fit_score: 3,
  proposed_role: "Prime",
  recommended_prime: null,
  why_this_org: ["Directly eligible as a community college with an active CTE program aligned to the funded work."],
  reasoning_context: { role_assignment_logic: "Eligible to prime as an IHE that runs employer-aligned workforce training." },
  ...over,
});

const awardSummary: ProgramAwardSummary = {
  cfdas: ["17.282"],
  programTitles: ["Workforce Pipelines"],
  scope: "recipient_location",
  timePeriod: { start: "2016-01-01", end: "2026-01-01" },
  totalAmount: 240_000_000,
  totalAwardsFetched: 310,
  awardsTruncated: false,
  byState: [
    { state: "AR", name: "Arkansas", amount: 6_400_000, count: 9 },
    { state: "TX", name: "Texas", amount: 40_000_000, count: 55 },
  ],
  topAwards: [
    { awardId: "1", recipient: "Ozark Technical Community College", amount: 2_000_000, agency: "DOL", startDate: "2024", state: "AR" },
    { awardId: "2", recipient: "Dallas County Community College District", amount: 3_000_000, agency: "DOL", startDate: "2023", state: "TX" },
  ],
};

async function sample(card: FitCard, grant: FitGrant, client: Client, band: "strong" | "conditional"): Promise<string[]> {
  const out: string[] = [];
  for (let i = 0; i < RUNS; i++) out.push((await generateFitNarrative(card, grant, client, band)) ?? "");
  return out;
}

const lower = (s: string) => s.toLowerCase();
const isMachineryClean = (s: string) =>
  s.length > 0 && !FORBIDDEN_NARRATIVE_MARKERS.some((m) => lower(s).includes(m)) && !/[SP]\d/.test(s);
const hasNoNumericScore = (s: string) => !/\b[1-3]\s*\/\s*3\b/.test(s) && !/\bscore\b/i.test(s);
const opensWithoutLabel = (s: string) => !/^\s*(go|no-?go|marginal)\b/i.test(s);
const sentenceCount = (s: string) => (s.match(/[^.!?]+[.!?]+/g) ?? [s]).length;
const majority = (bools: boolean[]) => bools.filter(Boolean).length > bools.length / 2;

describe.skipIf(!RUN)("fit-analysis narrative eval (live Opus)", () => {
  it("[STRONG 3] builds the affirmative case across the axes; award history stays state-presence only", async () => {
    const out = await sample(cardOf(), grantOf({ program_award_summary: awardSummary }), clientOf(), "strong");
    out.forEach((n, i) => console.log(`\n[STRONG run ${i + 1}] ${n}`));
    const nonEmpty = out.filter((n) => n.length > 0);

    // Mostly clean + non-empty (a run the guard nulled would be "" — a leak signal).
    expect.soft(majority(out.map((n) => isMachineryClean(n))), "machinery-clean, non-empty").toBe(true);
    // Client-safe hard invariants on every non-empty run.
    for (const n of nonEmpty) {
      expect.soft(hasNoNumericScore(n), `no numeric score: ${n}`).toBe(true);
      expect.soft(opensWithoutLabel(n), `no go/no-go opener: ${n}`).toBe(true);
      // The compliance guardrail: NO by-applicant-type award claim, and no leaked recipient name.
      expect.soft(!BY_TYPE_AWARD_MARKERS.some((m) => lower(n).includes(m)), `no by-type award claim: ${n}`).toBe(true);
      expect.soft(!/Ozark Technical|Dallas County Community/.test(n), `no leaked recipient name: ${n}`).toBe(true);
    }
    // Covers the axes in the majority: eligibility, the funded theme (mission↔funds), and the role.
    expect.soft(majority(nonEmpty.map((n) => /eligib|applicant|community college/i.test(n))), "names eligibility").toBe(true);
    expect.soft(majority(nonEmpty.map((n) => /workforce|training|career|technical|employer/i.test(n))), "names the funded work").toBe(true);
    // THE PHASE-1 BAR: reads the NOFO, not the brief. Each marker below is a decision factor that appears
    // ONLY in raw_text (the 25% match, the rural/persistent-poverty competitive priority, the Title IV /
    // existing-CTE eligibility gate, the SAM registration reality) — none is in the one-line brief. A
    // narrative that surfaces at least one has genuinely analyzed the document. This is the gate the prompt
    // is iterated against; if the majority miss it, the prompt is still writing a longer brief.
    const readsNofo = (n: string) =>
      /\bmatch\b|cost.?shar|non-?federal|25\s?%/i.test(n) ||
      /rural|persistent poverty|high[- ]poverty|competitive prefer|preference points/i.test(n) ||
      /title iv|accredit|existing (cte|career)|registered apprentice|stackable/i.test(n) ||
      /sam\.gov|sam registration/i.test(n);
    expect.soft(majority(nonEmpty.map(readsNofo)), "reads the NOFO: surfaces a raw_text-only decision factor, not just the brief").toBe(true);
  }, EVAL_TIMEOUT_MS);

  it("[CONDITIONAL 2] names the real hurdle honestly — no oversell", async () => {
    // A prime-ineligible specialist nonprofit routed to a SUPPORTING seat under a government prime.
    const client = clientOf({
      name: "Restore Hope Reentry",
      org_type: "nonprofit",
      client_profile: {
        summary: "A community-based reentry nonprofit.",
        mission: "Support formerly incarcerated adults with reentry services and job placement.",
        funding_priorities: ["reentry services", "workforce reentry"],
        core_capabilities: ["case management", "reentry programming"],
      } as unknown as Client["client_profile"],
    });
    const card = cardOf({
      fit_score: 2,
      proposed_role: "Sub",
      recommended_prime: "county government",
      why_this_org: ["Fills a community-based reentry provider seat; cannot prime a government-only grant."],
      reasoning_context: { role_assignment_logic: "Prime-ineligible as a nonprofit on a government-only NOFO; routed to a supporting seat under a county." },
    });
    const grant = grantOf({
      title: "Second Chance Act Community Reentry",
      description_brief: "Funds units of local government to reduce recidivism through reentry services delivered with community partners.",
      eligible_entity_types: ["local_government"],
      // Its own NOFO (not the workforce one). The lead-eligibility gate + the MOU are the real hurdle a
      // reentry nonprofit faces here — raw_text-only specifics the model should surface as the catch.
      raw_text: `NOTICE OF FUNDING OPPORTUNITY — Second Chance Act Community Reentry Program

A. Eligibility. Eligible applicants are states, units of LOCAL GOVERNMENT, and federally recognized tribes. Nonprofit and community-based organizations are NOT eligible to apply as the lead applicant, but are expected to deliver services as SUBRECIPIENTS under an eligible governmental lead.

B. Required Partnership. Each application must include a MEMORANDUM OF UNDERSTANDING with the corrections or community-supervision agency that will refer participants, and a data-sharing agreement for recidivism tracking.

C. Competitive Priority. Preference points for applications serving jurisdictions with above-average recidivism and for projects that braid in evidence-based case management and workforce reentry.

D. Deadline. Applications due via Grants.gov; an active SAM.gov registration is required at submission.`,
    });
    const out = await sample(card, grant, client, "conditional");
    out.forEach((n, i) => console.log(`\n[CONDITIONAL run ${i + 1}] ${n}`));
    const nonEmpty = out.filter((n) => n.length > 0);

    expect.soft(majority(out.map((n) => isMachineryClean(n))), "machinery-clean, non-empty").toBe(true);
    for (const n of nonEmpty) {
      expect.soft(hasNoNumericScore(n), `no numeric score: ${n}`).toBe(true);
      expect.soft(opensWithoutLabel(n), `no go/no-go opener: ${n}`).toBe(true);
    }
    // The catch must be named: the partner/prime structure, or the "cannot prime / sub under" reality.
    expect.soft(
      majority(nonEmpty.map((n) => /prime|partner|sub|county|lead applicant|before the deadline/i.test(n))),
      "names the partner/prime hurdle",
    ).toBe(true);
  }, EVAL_TIMEOUT_MS);

  it("[SPARSE] thin profile → a SHORTER honest note, not mail-merge filler", async () => {
    const sparseClient = clientOf({
      name: "Delta Regional Alliance",
      org_type: "nonprofit",
      client_profile: null,
      primary_funding_needs: [],
      service_area: [],
    });
    const out = await sample(cardOf({ fit_score: 2, proposed_role: "Sub", recommended_prime: "county government" }), grantOf(), sparseClient, "conditional");
    out.forEach((n, i) => console.log(`\n[SPARSE run ${i + 1}] ${n}`));
    const nonEmpty = out.filter((n) => n.length > 0);

    // It must still SAY something honest (not empty), and stay client-safe.
    expect.soft(nonEmpty.length, "produced a non-empty note").toBeGreaterThan(0);
    for (const n of nonEmpty) {
      expect.soft(isMachineryClean(n), `machinery-clean: ${n}`).toBe(true);
      expect.soft(hasNoNumericScore(n), `no numeric score: ${n}`).toBe(true);
      // No mail-merge filler artifacts from an empty mission ("seeks funding for ." / "The program funds .").
      expect.soft(!/\b(for|funds|supports)\s*\.\s/i.test(n), `no empty mail-merge slot: ${n}`).toBe(true);
    }
    // SHORTER: a thin-but-honest note is brief — the majority should be at most 3 sentences.
    expect.soft(majority(nonEmpty.map((n) => sentenceCount(n) <= 3)), "brief (≤3 sentences) in the majority").toBe(true);
  }, EVAL_TIMEOUT_MS);
});
