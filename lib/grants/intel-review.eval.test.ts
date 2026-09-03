import { describe, it, expect } from "vitest";
import { runIntelReview, type IntelCard } from "./intel-review";
import { FORBIDDEN_NARRATIVE_MARKERS } from "./fit-narrative";
import type { Grant, Client } from "@/types/database";

// ── IntellEngine QA eval — the on-demand Intel pass ────────────────────────────────────────────────
//
// MODEL-IN-THE-LOOP + LIVE WEB. NOT a unit test; MUST NOT run in the normal suite or the sandbox — it
// makes real Opus calls AND real fetchGrantSource GETs to live .gov pages. Skipped unless
// RUN_INTEL_EVAL=1 AND ANTHROPIC_API_KEY is present. Run it in preview/CI or a shell with both:
//
//   RUN_INTEL_EVAL=1 INTEL_EVAL_RUNS=3 ANTHROPIC_API_KEY=... \
//   npx vitest run lib/grants/intel-review.eval.test.ts
//
// THIS IS THE REAL DELIVERABLE. The whole point of building on-demand first is to find out, on live
// data, whether an Opus + fetch-only pass can pull an allocation reality the engine missed. The
// fixtures are SYNTHETIC (constructed here) but the model and the fetches are REAL, so the eval has no
// prod-DB dependency and is reproducible — the only external dependencies are Anthropic and the live
// .gov source.
//
// THE VERDICT-NARRATIVE WIDENING (2026-09-01). The client-safe narrative is now the REASONING BODY under a
// deterministic go/no-go LEAD, and it rides EVERY resolved verdict (affirm / demote / flag), not just a
// demote. The deterministic LEAD itself — the "No-go / Marginal / Go for <client>" call, its pin to the
// displayed score, and the closed/ineligible hard kills — is DETERMINISTIC and unit-tested in
// lib/report/recommendation.test.ts (no model), so this eval owns only the MODEL half: that the narrative is
// faithful, clean, and VERDICT-SHAPED (leads with the decisive reason, distinguishes eligible-vs-competitive,
// names the hurdle, restates neither the call word nor a numeric score). Case 2 proves an AFFIRM now carries
// its own go-reasoning (the widening); case 8 proves the eligible-but-functionally-wrong voice (both halves).
//
// TWO COHORTS, because apply-mode writes the verdict to the card and PR A LOOSENED the grounding guard
// (host-grounding + refute, no verbatim quote), so the eval must prove BOTH directions before the flag
// flips: (DEMOTE cohort) QA lowers the genuinely-wrong matches, and (AFFIRM cohort) QA leaves the
// genuinely-good matches UNTOUCHED — the over-demote guard, which is the real risk of a looser guard.
// Eight cases — [D] = demote cohort (catches the wrong matches), [A] = affirm cohort (leaves the good
// matches untouched — the over-demote guard), [F] = fail-safe, [N] = narrative voice:
//
//   1. [D] JAG-county-GROUNDED-DEMOTE (discovery ON) — Mississippi County (AR, local_government) scored a confident
//      direct-recipient 3 on Byrne-JAG Local (CFDA 16.738). An AR county is a disparate / "asterisk"
//      jurisdiction on the JAG local allocation list and cannot prime a direct application. Runs discovery ON
//      (the flag-on path), but 16.738 is a SEEDED program, so the pass FETCHES the seeded allocation URL
//      rather than SEARCHING (0 web_searches is correct — search is for UNSEEDED programs; see VOCA).
//      GUARD (Step 3, PR A, as amended by PR F): earlier gates downgraded this well-reasoned demote to
//      `unverified` — first for lacking a VERBATIM PDF quote, then for the phase-2 model not echoing the
//      fetched URL (three eval runs of "cited no page" despite reading the real FY26 table), then — the same
//      class of over-strict guard — the adversarial refute over-refuting a CORRECT grounded demote (the
//      live MS County incident). The final guard grounds on the FETCH ITSELF (a relevant .gov page was
//      retrieved) and APPLIES a grounded demote; the refute is now an ADVISORY note, not a veto. So the bar:
//      the pass must land a GROUNDED **demote** (not merely never-affirm) in the MAJORITY of runs, naming the
//      Arkansas allocation reality — and with the refute veto gone this is MORE reliable, not less. The
//      "never demote from nothing" fail-safe is unchanged and still HARD every run — no adverse verdict
//      without a successful .gov fetch — and a run that genuinely can't reach a source still honestly falls
//      to `unverified` (never a guess).
//
//   2. [A] JAG-state-AFFIRM    — the State of Arkansas (state_government, the State Administering Agency)
//      on the SAME program IS a direct JAG recipient. QA must NOT over-demote a genuine direct
//      recipient. This is the carve-out that proves the pass discriminates rather than blanket-demotes.
//
//   3. [F] no-source-UNVERIFIED — a card whose only "source" is unreachable (non-.gov, unseeded CFDA). An
//      adverse verdict is STRUCTURALLY impossible without a successful fetch (finalizeIntel's grounding
//      guard), so the verdict must NOT be demote/flag. Proves fail-safe end-to-end on the live path.
//
//   4. [D] VOCA-nonprofit-GROUNDED-DEMOTE (discovery ON) — a nonprofit victim-services org scored a
//      confident direct 3 on VOCA Victim Assistance (CFDA 16.575), a FORMULA grant to the states where
//      local/nonprofit providers are SUBGRANTEES through the state VOCA administering agency, not direct
//      federal applicants. 16.575 is now SEEDED (allocation-sources: the OVC formula-grants page STATES
//      the rule on the landing page itself — "submitted online only by the state agency designated by the
//      Governor" / "the states provide subgrants to local community-based organizations"), so the pass
//      FETCHES that page and grounds the demote on the page body rather than needing to search a sub-page.
//      The bar now mirrors JAG (#1): a GROUNDED **demote** in the MAJORITY of runs, naming the
//      state-administering-agency / subgrantee reality; the fail-safe (no adverse without a grounded
//      fetch) still holds every run. This was formerly a fail-safe-only case (unseeded); the seed is what
//      makes the demote reliable, so it is now the flip gate for adding 16.575 to APPLY_ELIGIBLE_CFDAS.
//
//   5. [A] COPS-Hiring × city-PD-AFFIRM — the City of Fayetteville Police Department (local_government) on
//      the COPS Hiring Program (CFDA 16.710). This is the AFFIRM cohort's sharpest stressor: a local
//      government on a DOJ justice grant, superficially identical to the JAG-county DEMOTE — but COPS
//      Hiring is a COMPETITIVE discretionary grant where local law-enforcement agencies apply DIRECTLY (no
//      allocation formula, no asterisk table, not in FORMULA_PROGRAMS). QA must NOT reflexively demote a
//      local-gov-on-a-justice-grant; it must read the source and affirm the genuine direct applicant. The
//      bar: NOT demoted in the majority of runs (a from-nothing "unverified" is acceptable — it doesn't
//      change the score; a DEMOTE here is the over-demote failure the looser guard risks).
//
//   6. [A] AFG × fire-dept-AFFIRM — the Springdale Fire Department (local_government) on the Assistance to
//      Firefighters Grants (CFDA 97.044), a COMPETITIVE FEMA grant fire departments apply to DIRECTLY.
//      A second genuine direct applicant in a different agency/context, so the affirm cohort isn't a single
//      program. Same bar: NOT demoted in the majority of runs.
//
//   7. [A] VOCA × state-agency-AFFIRM (discovery ON) — the state VOCA administering agency
//      (state_government) on the SAME seeded VOCA program (16.575) IS the direct recipient. QA must NOT
//      over-demote the genuine administering agency. VOCA's mirror of the JAG state-affirm (#2): it proves
//      the pass discriminates the subgrant-only nonprofit (#4, demote) from the administering agency
//      (affirm) rather than blanket-demoting VOCA, and it is the no-false-demote guard the 16.575 flip
//      rests on. Runs discovery ON (like #4) so it exercises the same seeded flag-on path as the demote.
//
//   8. [N] DOE-fossil-energy × two-year college — NorthWest Arkansas Community College (higher_education) on a
//      DOE fossil-energy R&D program. Entity-eligible as an IHE, but a teaching college with no research
//      faculty — Shannon's target voice. Tests the NARRATIVE, not the verdict direction (a grounded demote on
//      the NOFO's PI/research requirement AND an affirm-of-the-conditional-2 are both defensible): the
//      fail-safe holds, and any narrative written must be clean, verdict-shaped, AND name BOTH the higher-ed
//      eligibility and the research-capacity gap (the eligible-vs-competitive distinction).
//
// Cases 5-6 run discovery:false — they are not formula programs, so a formula note never fires; keeping
// discovery off makes the affirm result flag-independent and keeps the pass to a single fetch (fast). The
// VOCA pair (4, 7) runs discovery ON — 16.575 is a seeded formula program, so both sides take the flag-on
// fetch-the-seed path, and the pair is what proves the flip (demote the nonprofit, affirm the state).
//
// Majority-of-runs assertions (expect.soft), because a single Opus run varies. The bar is the feature's
// philosophy: adverse ONLY when web-grounded; never over-demote a clear direct recipient. The AFFIRM
// cohort (cases 2, 5, 6, 7) is the guard that PR A's looser grounding did not open an over-demote hole.

const RUN = process.env.RUN_INTEL_EVAL === "1" && !!process.env.ANTHROPIC_API_KEY;
const RUNS = Math.max(1, Number(process.env.INTEL_EVAL_RUNS) || 3);

const client = (over: Partial<Client>): Client =>
  ({ name: "Test", org_type: "local_government", location_city: null, location_state: "AR", service_area: null, matching_rules: null, known_constraints: null, client_profile: null, ...over }) as unknown as Client;

const grant = (over: Partial<Grant> = {}): Grant =>
  ({
    title: "Edward Byrne Memorial Justice Assistance Grant (JAG) Program — Local",
    funder: "Bureau of Justice Assistance",
    assistance_listings: [{ number: "16.738", program_title: "Byrne JAG" }],
    program_type: "Competitive Grant",
    eligible_entity_types: ["units of local government"],
    geographic_eligibility: "nationwide",
    // A real, stable JAG program page so the model has a NOFO-side .gov to read as well as the seed.
    source_url: "https://bja.ojp.gov/program/jag/overview",
    ...over,
  }) as unknown as Grant;

const card = (over: Partial<IntelCard> = {}): IntelCard => ({
  fit_score: 3,
  proposed_role: "Prime",
  recommended_prime: null,
  why_this_org: ["Paradigmatic direct recipient; no consortium required."],
  before_you_approve: [],
  reasoning_context: { fit_score_derivation: "Units of local government are eligible; scored as a direct applicant." },
  ...over,
});

// NorthWest Arkansas Community College — the PURPOSE-FIT fixture (Shannon's live audit target). One
// confirmed identity that makes the four purpose-fit cases below discriminate: an entity-eligible IHE that
// GENUINELY performs technical/workforce education (its core mission) and runs a routine campus library,
// but has NO museum and NO research capacity. So: museum-workforce → demote (no museum), national library
// research → demote (a library ≠ national research), library workforce → affirm (genuine overlap),
// technician education → affirm (its core work, even as a smaller competitor).
const nwacc = (over: Partial<Client> = {}): Client =>
  client({
    name: "NorthWest Arkansas Community College",
    org_type: "higher_education",
    location_state: "AR",
    known_constraints:
      "Two-year, teaching-focused community college. Core mission is associate-degree career/technical and workforce education. Runs a routine campus library serving students and the local community. NO museum, no museum collection, no curatorial staff. No research faculty, no sponsored-research office, no principal investigators; not a research institution. No graduate library-science (MLIS) program.",
    ...over,
  });

async function runN<T>(n: number, fn: () => Promise<T>): Promise<T[]> {
  // Small serial loop — the eval is low-volume and a live model; no need to hammer concurrently.
  const out: T[] = [];
  for (let i = 0; i < n; i++) out.push(await fn());
  return out;
}

const majority = (bools: boolean[]) => bools.filter(Boolean).length > bools.length / 2;

// The verdict narrative is the REASONING body under a directional call the card states deterministically.
// Two model-dependent shape properties the eval gates (the deterministic lead/pin/bands are unit-tested in
// lib/report/recommendation.test.ts, not here):
//   - CLEAN: no internal-framing / scoring-machinery language (the runtime narrativeGuard already nulls a
//     leak, so a present narrative is clean by construction — asserted anyway to catch a guard hole).
//   - VERDICT-SHAPED: it does NOT restate the "go / no-go / marginal" call word (the card owns that), and it
//     carries NO bare numeric fit score ("a 2/3", "scored a 3", "conditional 2") — the new spec is prose only.
const narrativeClean = (n: string) => FORBIDDEN_NARRATIVE_MARKERS.every((m) => !n.toLowerCase().includes(m));
const narrativeVerdictShaped = (n: string) =>
  !/^\s*(no-?go|go for|marginal)\b/i.test(n.trim()) &&
  !/\b[123]\s*\/\s*3\b|\bfit score\b|\bscored (?:a )?[123]\b|\bconditional [123]\b/i.test(n);
// NO SUPPORTING-SEAT CODES: the matcher's unambiguous "S<n>_<m>" labels must never reach a client
// paragraph. End-to-end invariant lock — the prompt discourages emitting them AND narrativeGuard strips
// any that slip — so it fails loudly if BOTH regress. (Only the underscore form is asserted: a prime
// "P<n>" is NOT stripped because it collides with real identifiers — NIH P30, phase P2 — Codex #480;
// deterministic behaviour is unit-tested in fit-narrative.test.ts.)
const narrativeNoSeatCodes = (n: string) => !/\bS\d+_\d+\b/.test(n);

describe.skipIf(!RUN)("IntellEngine QA eval (live Opus + fetch)", () => {
  it(
    "1. JAG × Mississippi County, discovery ON → GROUNDED DEMOTE (host-grounded + survives refute; no verbatim quote needed)",
    async () => {
      // Discovery ON, the way the flag-on feature actually runs. 16.738 is a SEEDED program, so the pass
      // FETCHES the seeded allocation URL rather than SEARCHING (0 web_searches is correct here — search is
      // for UNSEEDED programs; see the VOCA case). REDESIGNED GUARD: the pass grounds on the fetched .gov
      // source (audit ok-set) and the demote must survive an adversarial refute — it no longer needs a
      // verbatim PDF-table quote, so a correctly-reasoned demote is applied rather than downgraded to
      // `unverified`. The bar: a GROUNDED demote in the majority of runs, naming the Arkansas allocation
      // reality; the fail-safe (no adverse without a grounded fetch) still holds every run.
      const results = await runN(RUNS, () =>
        runIntelReview(
          card(),
          grant(),
          client({ name: "Mississippi County", org_type: "local_government", location_state: "AR" }),
          // narrative ON so the SAME grounded run that lands the demote also writes the client paragraph —
          // the strongest no-regression check (the narrative field must not perturb the verdict/score).
          { discovery: true, narrative: true },
        ),
      );
      const notAffirmed = results.map((r) => r.verdict !== "affirm");
      const demoted = results.map((r) => r.verdict === "demote" || r.verdict === "flag");
      const grounded = results.map((r) => r.fetched.some((f) => f.ok));
      const reasoned = results.map((r) => /asterisk|disparate|through the state|state administering|cannot (prime|apply)|allocation|not.*direct/i.test(r.summary));
      // Informative surfacing of what actually happened, so a failing run says WHY.
      console.log("[intel-eval] JAG-county searches:", results.map((r) => r.searched.length).join(", "));
      console.log("[intel-eval] JAG-county verdicts:", results.map((r) => `${r.verdict}${r.qa_fit_score != null ? `→${r.qa_fit_score}` : ""}`).join(", "));
      console.log("[intel-eval] JAG-county summaries:", results.map((r) => r.summary));
      // Fail-safe (HARD, every run): no adverse verdict without a grounded fetch.
      for (const r of results) {
        if (r.verdict === "demote" || r.verdict === "flag") {
          expect.soft(r.fetched.some((f) => f.ok), "adverse JAG-county verdict must rest on a grounded .gov fetch (fail-safe)").toBe(true);
        }
      }
      // CORRELATE the adverse verdict with the ARKANSAS ALLOCATION reality it grounds on — not merely that
      // SOME search ran and SOME page was fetched. This closes the false-green where a run could search for
      // something unrelated and demote off the stale prior-year PDF or the generic JAG overview: an adverse
      // summary must name Arkansas AND the allocation / disparate-jurisdiction structure. (We deliberately do
      // NOT hard-assert the exact current-YEAR fetched URL — the fixture is evergreen and carries no NOFO
      // year, so pinning a year would make the eval brittle and self-falsifying every fall; the actual
      // grounded source + year is read from the eval logs when interpreting the result. In run 2 the model
      // itself refused to ground a demote on the stale prior-year table, which is the behavior this guards.)
      for (const r of results) {
        if (r.verdict === "demote" || r.verdict === "flag") {
          expect.soft(
            /arkansas|\bAR\b/i.test(r.summary) &&
              /alloc|disparate|asterisk|through the (state|county)|sub-?recipient|subgrant|state administering/i.test(r.summary),
            "an adverse JAG-county verdict must name the Arkansas allocation reality it grounded on (not stale/generic evidence)",
          ).toBe(true);
        }
      }
      // The county is a SEEDED program (16.738 has an allocation URL), so the pass FETCHES it rather than
      // SEARCHING — 0 web_searches is correct here (search is for UNSEEDED programs, proven by the VOCA case),
      // which is why there is no searchedUsed assertion. REDESIGNED GUARD: grounding no longer needs a verbatim
      // PDF-table quote — a host-grounded, refute-surviving demote is APPLIED. So the primary bar is now a
      // GROUNDED **demote** in the majority of runs (the whole point of the guard fix); never-affirm and the
      // allocation-reality naming remain, and the fail-safe (no adverse without a grounded fetch) still holds
      // every run (asserted above). A run that genuinely can't ground still falls honestly to `unverified`.
      expect.soft(majority(grounded), "should reach + ground a .gov allocation source in the majority of runs").toBe(true);
      expect.soft(majority(demoted), "the redesigned guard must APPLY a grounded demote (not downgrade to unverified for lack of a verbatim quote) in the majority of runs").toBe(true);
      expect.soft(majority(notAffirmed), "must NOT affirm a disparate/asterisk county as a clean prime").toBe(true);
      expect.soft(majority(reasoned), "the Intel summary should name the allocation reality").toBe(true);

      // CLIENT NARRATIVE (Step C) — proven on the SAME runs. On a grounded demote the pass also writes ONE
      // client-safe paragraph that will replace the engine fit-factor text. TWO-PART FAITHFULNESS GUARD:
      //   (a) it preserves the grounded HARD fact (never softens "cannot prime" → "may face challenges");
      //   (b) it carries NO internal-framing / scoring machinery (the runtime guard already nulls a leak,
      //       so a present narrative is clean by construction — we assert it anyway to catch a guard hole).
      // NO-REGRESSION is already established above: narrative:true did not stop the demote from landing.
      const demoteRuns = results.filter((r) => r.verdict === "demote");
      console.log("[intel-eval] JAG-county narratives:", demoteRuns.map((r) => r.narrative));
      const narrated = demoteRuns.map((r) => !!r.narrative);
      const faithful = demoteRuns.map(
        (r) => !!r.narrative && /cannot|asterisk|disparate|\bMOU\b|prohibit|through the (state|county)|fiscal agent|not.*(a )?direct/i.test(r.narrative),
      );
      const clean = demoteRuns.map((r) => !r.narrative || narrativeClean(r.narrative));
      // VERDICT-SHAPED: even a demote narrative must not restate the "no-go" call the card states, and must
      // carry no bare numeric fit score — it is the reasoning body, prose only.
      const shaped = demoteRuns.map((r) => !r.narrative || narrativeVerdictShaped(r.narrative));
      const noCodes = demoteRuns.map((r) => !r.narrative || narrativeNoSeatCodes(r.narrative));
      // LENGTH CAP (visual): the prompt targets ~175 words / ~1,000 chars — a client card, not a memo. The
      // eval bar allows a small overage (≤1,100) since it is a model target, and logs the actual lengths.
      const lengths = demoteRuns.map((r) => r.narrative?.length ?? 0);
      console.log("[intel-eval] JAG-county narrative lengths:", lengths.join(", "));
      const withinCap = demoteRuns.map((r) => !r.narrative || r.narrative.length <= 1100);
      expect.soft(demoteRuns.length === 0 || majority(narrated), "a grounded demote should carry a client narrative in the majority of runs").toBe(true);
      expect.soft(demoteRuns.length === 0 || majority(faithful), "the narrative must preserve the grounded hard fact, not soften it (rule a)").toBe(true);
      expect.soft(clean.every(Boolean), "the narrative must carry NO internal-framing / scoring-machinery language (rule b)").toBe(true);
      expect.soft(shaped.every(Boolean), "the narrative must not restate the no-go call or a numeric fit score (verdict-shaped)").toBe(true);
      expect.soft(noCodes.every(Boolean), "the narrative must carry NO internal seat/role codes (S0_2, P0) — client machinery leak").toBe(true);
      expect.soft(demoteRuns.length === 0 || majority(withinCap), "the narrative should stay within the ~1,000-char client-card cap in the majority of runs").toBe(true);
    },
    RUNS * 200_000,
  );

  it(
    "2. JAG × State of Arkansas → AFFIRM (do NOT over-demote a genuine direct recipient)",
    async () => {
      const results = await runN(RUNS, () =>
        runIntelReview(
          card({ why_this_org: ["State administering agency; direct JAG recipient."], reasoning_context: { fit_score_derivation: "State is the direct recipient / State Administering Agency for JAG." } }),
          grant({ title: "Edward Byrne Memorial Justice Assistance Grant (JAG) Program — State", eligible_entity_types: ["states", "state administering agencies"] }),
          client({ name: "State of Arkansas", org_type: "state_government", location_state: "AR" }),
          { discovery: false, narrative: true },
        ),
      );
      console.log("[intel-eval] JAG-state verdicts:", results.map((r) => r.verdict).join(", "));
      console.log("[intel-eval] JAG-state narratives:", results.map((r) => r.narrative));
      const notDemoted = results.map((r) => r.verdict !== "demote");
      expect.soft(majority(notDemoted), "a state IS a direct JAG recipient — QA must not demote it").toBe(true);
      // VERDICT NARRATIVE WIDENING: the reasoning body now rides EVERY resolved verdict, so a genuine AFFIRM
      // carries its OWN go-reasoning paragraph (not just a demote). The bar:
      //   - a non-unverified verdict CARRIES a narrative in the majority of runs (the widening works);
      //   - an UNVERIFIED verdict carries NONE (finalizeIntel nulls it — the card keeps the engine paragraph);
      //   - every present narrative is CLEAN (no framing/machinery) and VERDICT-SHAPED (does not restate the
      //     "go/no-go" call the card states deterministically, and carries no bare numeric fit score).
      const resolvedRuns = results.filter((r) => r.verdict !== "unverified");
      const narratedAffirm = resolvedRuns.map((r) => !!r.narrative);
      expect.soft(resolvedRuns.length === 0 || majority(narratedAffirm), "a resolved (affirm/flag) verdict should carry a go-reasoning narrative in the majority of runs").toBe(true);
      for (const r of results) {
        if (r.verdict === "unverified") {
          expect.soft(r.narrative, "an unverified verdict carries no narrative — the card keeps the engine paragraph").toBeNull();
        }
        if (r.narrative) {
          expect.soft(narrativeClean(r.narrative), "an affirm narrative must carry NO internal-framing / scoring-machinery language").toBe(true);
          expect.soft(narrativeVerdictShaped(r.narrative), "the narrative must not restate the go/no-go call or a numeric fit score — the card states the call").toBe(true);
          expect.soft(narrativeNoSeatCodes(r.narrative), "the narrative must carry NO internal seat/role codes (S0_2, P0)").toBe(true);
        }
      }
    },
    RUNS * 200_000,
  );

  it(
    "3. unreachable source → verdict is NEVER adverse (fail-safe end-to-end)",
    async () => {
      // Unseeded CFDA + a non-.gov source: nothing is fetchable, so an adverse verdict is structurally
      // impossible (grounding guard). Verdict must be affirm or unverified, never demote/flag.
      const results = await runN(RUNS, () =>
        runIntelReview(
          card(),
          grant({ assistance_listings: [{ number: "99.999", program_title: "Unseeded" }], source_url: "https://example.com/not-a-gov-page" }),
          client({ name: "Somewhere County", org_type: "local_government" }),
          { discovery: false },
        ),
      );
      console.log("[intel-eval] no-source verdicts:", results.map((r) => r.verdict).join(", "));
      for (const r of results) {
        expect.soft(r.verdict === "demote" || r.verdict === "flag", "no adverse verdict is allowed without a grounded fetch").toBe(false);
      }
    },
    RUNS * 200_000,
  );

  it(
    "4. VOCA × nonprofit, discovery ON → GROUNDED DEMOTE (seeded OVC formula page states the subgrantee rule)",
    async () => {
      // 16.575 is now SEEDED (allocation-sources → the OVC formula-grants page). That page STATES the rule
      // on the landing page itself ("submitted online only by the state agency designated by the Governor";
      // "the states provide subgrants to local community-based organizations"), so the pass FETCHES the
      // seeded page and grounds the demote on the page body — no sub-page search needed, so it grounds more
      // reliably than JAG's table-in-a-PDF. Bar mirrors JAG (#1): a GROUNDED demote in the majority of runs,
      // naming the administering-agency / subgrantee reality; the fail-safe (no adverse without a grounded
      // fetch) still holds every run. This is the flip gate for adding 16.575 to APPLY_ELIGIBLE_CFDAS.
      const results = await runN(RUNS, () =>
        runIntelReview(
          card({
            why_this_org: ["Nonprofit victim-services provider; scored as a direct applicant."],
            reasoning_context: { fit_score_derivation: "Nonprofit victim service organizations are eligible; scored as a direct recipient." },
          }),
          grant({
            title: "Crime Victim Assistance (VOCA) — Victim Assistance Formula Grant",
            funder: "Office for Victims of Crime",
            assistance_listings: [{ number: "16.575", program_title: "Crime Victim Assistance" }],
            eligible_entity_types: ["nonprofit organizations", "victim service organizations"],
            // A real, live OVC .gov funding landing page (NOFO-side). The AUTHORITATIVE formula/subgrant page
            // is now the SEEDED allocation source (allocation-sources 16.575 → the OVC formula-grants page),
            // which the pass fetches and grounds on.
            source_url: "https://ovc.ojp.gov/funding",
          }),
          client({ name: "Hope Victim Services", org_type: "nonprofit", location_state: "AR" }),
          // narrative ON, mirroring JAG #1 — the same grounded run that lands the demote also writes the
          // client paragraph (the strongest no-regression check).
          { discovery: true, narrative: true },
        ),
      );
      const notAffirmed = results.map((r) => r.verdict !== "affirm");
      const demoted = results.map((r) => r.verdict === "demote" || r.verdict === "flag");
      const grounded = results.map((r) => r.fetched.some((f) => f.ok));
      const reasoned = results.map((r) =>
        // The subgrantee reality has several correct phrasings the model uses interchangeably: a "subgrant"
        // / "subaward" through the state, the "Governor-designated state agency" that alone may apply, or
        // "not a direct" recipient. Accept all of them — the demote is what matters, not one exact word.
        /subgrant|subaward|sub-?recipient|through the state|state administering|administering agency|governor-designated|not.*(a )?direct|cannot (prime|apply)/i.test(r.summary),
      );
      console.log("[intel-eval] VOCA searches:", results.map((r) => r.searched.length).join(", "));
      console.log("[intel-eval] VOCA verdicts:", results.map((r) => `${r.verdict}${r.qa_fit_score != null ? `→${r.qa_fit_score}` : ""}`).join(", "));
      console.log("[intel-eval] VOCA grounded:", results.map((r) => r.fetched.some((f) => f.ok)).join(", "));
      console.log("[intel-eval] VOCA summaries:", results.map((r) => r.summary));
      // Fail-safe (HARD, every run): no adverse verdict without a grounded fetch.
      for (const r of results) {
        if (r.verdict === "demote" || r.verdict === "flag") {
          expect.soft(r.fetched.some((f) => f.ok), "adverse VOCA verdict must rest on a grounded .gov fetch (fail-safe)").toBe(true);
        }
      }
      // CORRELATE the adverse verdict with the subgrantee reality it grounds on — not merely that a page was
      // fetched: an adverse summary must name the state administering agency / subgrantee structure.
      for (const r of results) {
        if (r.verdict === "demote" || r.verdict === "flag") {
          expect.soft(
            /subgrant|subaward|sub-?recipient|through the state|state administering|administering agency|governor-designated|not.*(a )?direct/i.test(r.summary),
            "an adverse VOCA verdict must name the state-administering-agency / subgrantee reality it grounded on",
          ).toBe(true);
        }
      }
      // Seeded program → the pass FETCHES the seed (search optional). Bar mirrors JAG: a GROUNDED demote in
      // the majority of runs; never-affirm and subgrantee-reality naming hold; the fail-safe is hard every
      // run (above). A run that genuinely can't ground still falls honestly to `unverified`.
      expect.soft(majority(grounded), "should reach + ground the seeded OVC formula source in the majority of runs").toBe(true);
      expect.soft(majority(demoted), "the seeded VOCA pass must APPLY a grounded demote of a subgrant-only nonprofit in the majority of runs").toBe(true);
      expect.soft(majority(notAffirmed), "must NOT affirm a subgrant-only VOCA nonprofit as a clean prime").toBe(true);
      expect.soft(majority(reasoned), "the Intel summary should name the state-administering-agency / subgrantee reality").toBe(true);
    },
    RUNS * 240_000,
  );

  it(
    "7. VOCA × state administering agency → AFFIRM (do NOT over-demote the genuine direct recipient)",
    async () => {
      // VOCA's mirror of JAG #2: the state administering agency IS the direct VOCA recipient, so QA must NOT
      // demote it. Runs discovery ON (the seeded flag-on path, same as #4), so the VOCA pair proves the pass
      // DISCRIMINATES — demote the subgrant-only nonprofit (#4), affirm the administering agency (here) —
      // rather than blanket-demoting 16.575. This is the no-false-demote guard the 16.575 flip rests on.
      // Bar: NOT demoted in EVERY run (zero tolerance) — STRICTER than the majority bar on the non-apply
      // affirm cases (5/6). 16.575 is apply-eligible, so a SINGLE false demote of a genuine state
      // administering agency would lower a real recipient's LIVE score; a majority bar would pass a
      // 1-in-3 false demote (Codex #461). A from-nothing "unverified" is still acceptable — it does not
      // change the score; only a DEMOTE/flag is the over-demote failure this must reject outright.
      const results = await runN(RUNS, () =>
        runIntelReview(
          card({
            why_this_org: ["State administering agency for the VOCA formula program; direct recipient."],
            reasoning_context: { fit_score_derivation: "The state administering agency is the direct VOCA formula recipient." },
          }),
          grant({
            title: "Crime Victim Assistance (VOCA) — Victim Assistance Formula Grant",
            funder: "Office for Victims of Crime",
            assistance_listings: [{ number: "16.575", program_title: "Crime Victim Assistance" }],
            eligible_entity_types: ["state administering agencies"],
            source_url: "https://ovc.ojp.gov/funding",
          }),
          // The client must be the REAL Arkansas VOCA Victim-Assistance administering agency — the OVC
          // Arkansas page names it the Department of Finance and Administration, Office of Intergovernmental
          // Services (DFA-OIG). The prior fixture "Arkansas Division of Victim Services" is NOT the
          // designated agency, so a well-grounded pass correctly demoted it to subgrantee ("not the client
          // as named"), which is right behavior on a mismatched name, not the over-demote this guard tests.
          // Naming the genuine designated agency is what actually exercises "the true administering agency
          // affirms" (eval run #12).
          client({
            name: "Arkansas Department of Finance and Administration, Office of Intergovernmental Services (VOCA State Administering Agency)",
            org_type: "state_government",
            location_state: "AR",
          }),
          { discovery: true },
        ),
      );
      const notDemoted = results.map((r) => r.verdict !== "demote" && r.verdict !== "flag");
      console.log("[intel-eval] VOCA-state verdicts:", results.map((r) => `${r.verdict}${r.qa_fit_score != null ? `→${r.qa_fit_score}` : ""}`).join(", "));
      console.log("[intel-eval] VOCA-state summaries:", results.map((r) => r.summary));
      expect.soft(notDemoted.every(Boolean), "QA must NOT over-demote the state VOCA administering agency in ANY run — 16.575 is apply-eligible, so one false demote lowers a real recipient's live score (zero-tolerance guard)").toBe(true);
    },
    RUNS * 240_000,
  );

  // ── AFFIRM cohort (the over-demote guard) ──────────────────────────────────────────────────────────
  // Genuine direct applicants QA must LEAVE ALONE. Since PR A loosened the grounding guard (host-grounding
  // + refute, no verbatim quote), these prove the looser guard did not open a hole where QA lowers the
  // score on a real, directly-eligible match. The bar is NOT-demoted (over-demote is the failure); an
  // affirm that falls to "unverified" for lack of a fetch is acceptable — it does not change the score.

  it(
    "5. COPS Hiring × city police department → AFFIRM (competitive direct applicant; must NOT over-demote a local gov on a justice grant)",
    async () => {
      // The sharpest over-demote stressor: a local government on a DOJ justice grant, superficially the JAG
      // county — but COPS Hiring is COMPETITIVE and local law-enforcement agencies apply DIRECTLY (no
      // allocation formula, not in FORMULA_PROGRAMS). QA must read the source and affirm, not reflexively
      // demote by surface resemblance.
      const results = await runN(RUNS, () =>
        runIntelReview(
          card({
            why_this_org: ["Municipal law-enforcement agency; direct applicant to the COPS Hiring Program."],
            reasoning_context: { fit_score_derivation: "Local law enforcement agencies are eligible direct applicants for COPS Hiring; scored as a direct applicant." },
          }),
          grant({
            title: "COPS Hiring Program (CHP)",
            funder: "Office of Community Oriented Policing Services",
            assistance_listings: [{ number: "16.710", program_title: "Public Safety Partnership and Community Policing Grants" }],
            program_type: "Competitive Grant",
            eligible_entity_types: ["units of local government", "law enforcement agencies"],
            source_url: "https://cops.usdoj.gov/chp",
          }),
          client({ name: "City of Fayetteville Police Department", org_type: "local_government", location_city: "Fayetteville", location_state: "AR" }),
          { discovery: false },
        ),
      );
      const notDemoted = results.map((r) => r.verdict !== "demote");
      console.log("[intel-eval] COPS-affirm verdicts:", results.map((r) => `${r.verdict}${r.qa_fit_score != null ? `→${r.qa_fit_score}` : ""}`).join(", "));
      console.log("[intel-eval] COPS-affirm summaries:", results.map((r) => r.summary));
      expect.soft(majority(notDemoted), "COPS Hiring is a competitive DIRECT-applicant grant for local LEAs — QA must not over-demote a genuine direct applicant").toBe(true);
    },
    RUNS * 200_000,
  );

  it(
    "6. AFG × fire department → AFFIRM (competitive direct applicant, different agency)",
    async () => {
      // A second genuine direct applicant in a different agency/context (FEMA, not DOJ), so the affirm
      // cohort is not one program. Fire departments apply DIRECTLY to the Assistance to Firefighters Grants.
      const results = await runN(RUNS, () =>
        runIntelReview(
          card({
            why_this_org: ["Municipal fire department; direct applicant to the Assistance to Firefighters Grants."],
            reasoning_context: { fit_score_derivation: "Fire departments are eligible direct applicants for AFG; scored as a direct applicant." },
          }),
          grant({
            title: "Assistance to Firefighters Grants (AFG)",
            funder: "Federal Emergency Management Agency",
            assistance_listings: [{ number: "97.044", program_title: "Assistance to Firefighters Grants" }],
            program_type: "Competitive Grant",
            eligible_entity_types: ["fire departments", "nonaffiliated EMS organizations"],
            source_url: "https://www.fema.gov/grants/preparedness/firefighters/assistance-grants",
          }),
          client({ name: "Springdale Fire Department", org_type: "local_government", location_city: "Springdale", location_state: "AR" }),
          { discovery: false },
        ),
      );
      const notDemoted = results.map((r) => r.verdict !== "demote");
      console.log("[intel-eval] AFG-affirm verdicts:", results.map((r) => `${r.verdict}${r.qa_fit_score != null ? `→${r.qa_fit_score}` : ""}`).join(", "));
      console.log("[intel-eval] AFG-affirm summaries:", results.map((r) => r.summary));
      expect.soft(majority(notDemoted), "AFG is a competitive DIRECT-applicant grant for fire departments — QA must not over-demote a genuine direct applicant").toBe(true);
    },
    RUNS * 200_000,
  );

  it(
    "8. DOE fossil-energy R&D × two-year college → ELIGIBLE-BUT-FUNCTIONALLY-WRONG narrative (both halves present)",
    async () => {
      // Shannon's target voice: "Entity-eligible as an IHE, but this is a fossil-energy R&D grant and NWACC
      // has no research faculty, so it's a no-go." This tests the NARRATIVE, not the verdict direction — the
      // verdict here is defensibly EITHER a grounded demote (the NOFO page states a PI / research-capacity
      // requirement) OR an affirm-of-the-conditional-2 (entity-eligible; the capacity gap is a fit stretch, not
      // an allocation bar). So we do NOT assert the direction. We assert the FAIL-SAFE (no adverse without a
      // grounded fetch) and, whenever a narrative is written, that it is clean, verdict-shaped, AND draws the
      // ELIGIBLE-vs-COMPETITIVE distinction Shannon wants — it names the higher-ed eligibility AND the
      // research/faculty/R&D capacity gap. The deterministic no-go LEAD itself is unit-tested (recommendation.
      // test.ts); here we prove the model's reasoning body carries both halves.
      const results = await runN(RUNS, () =>
        runIntelReview(
          card({
            fit_score: 2,
            proposed_role: "Prime",
            why_this_org: ["Institution of higher education; entity-eligible for the program."],
            reasoning_context: { fit_score_derivation: "IHEs are eligible; scored a conditional 2 on entity eligibility." },
          }),
          grant({
            title: "Fossil Energy Research and Development — University Coal Research",
            funder: "Department of Energy",
            assistance_listings: [{ number: "81.089", program_title: "Fossil Energy Research and Development" }],
            program_type: "Competitive Grant",
            eligible_entity_types: ["institutions of higher education", "universities"],
            source_url: "https://www.energy.gov/fecm/science-innovation/office-fossil-energy",
          }),
          client({
            name: "NorthWest Arkansas Community College",
            org_type: "higher_education",
            location_state: "AR",
            known_constraints: "Two-year, teaching-focused community college. No research faculty, no sponsored-research office, no principal investigators, and no federal R&D track record.",
          }),
          { discovery: false, narrative: true },
        ),
      );
      console.log("[intel-eval] fossil-energy verdicts:", results.map((r) => `${r.verdict}${r.qa_fit_score != null ? `→${r.qa_fit_score}` : ""}`).join(", "));
      console.log("[intel-eval] fossil-energy narratives:", results.map((r) => r.narrative));
      // Fail-safe: no adverse verdict without a grounded fetch.
      for (const r of results) {
        if (r.verdict === "demote" || r.verdict === "flag") {
          expect.soft(r.fetched.some((f) => f.ok), "an adverse fossil-energy verdict must rest on a grounded .gov fetch (fail-safe)").toBe(true);
        }
      }
      const narrated = results.filter((r) => !!r.narrative);
      // Both halves of the eligible-vs-competitive distinction: names the higher-ed eligibility AND the
      // research/faculty/R&D capacity gap. This is the crux of Shannon's target voice.
      const bothHalves = narrated.map(
        (r) =>
          /higher ed|institution|university|college|\bIHE\b|two-?year|community college|eligible/i.test(r.narrative!) &&
          /research|faculty|\bR&D\b|principal investigator|\bPI\b|capacity|laborator/i.test(r.narrative!),
      );
      for (const r of narrated) {
        expect.soft(narrativeClean(r.narrative!), "the fossil-energy narrative must carry no framing/machinery language").toBe(true);
        expect.soft(narrativeVerdictShaped(r.narrative!), "the fossil-energy narrative must not restate the call or a numeric fit score").toBe(true);
        expect.soft(narrativeNoSeatCodes(r.narrative!), "the fossil-energy narrative must carry no internal seat/role codes (S0_2, P0)").toBe(true);
      }
      expect.soft(narrated.length === 0 || majority(bothHalves), "the narrative should distinguish entity-eligibility from the research-capacity gap (both halves) in the majority of narrated runs").toBe(true);
    },
    RUNS * 200_000,
  );

  // ── PURPOSE-FIT cohort (entity-eligible but does not perform the funded work) ─────────────────────────
  // The engine scores ENTITY eligibility as if it were PROGRAM fit: an eligible IHE lands a conditional 2 on
  // a program whose funded activity the org does not perform. The second QA error class SCORES that mismatch
  // (demote), not just narrates it. Two DEMOTE cases (a clear one and the subtler "has-the-asset" one) and
  // two AFFIRM controls (a genuine same-domain overlap, and the competitive-weakness guard) prove the class
  // catches the miss WITHOUT over-demoting a real fit — the top risk, since broad apply runs it unattended.
  // IMLS is neither seeded (allocation-sources) nor formula-tagged, so grounding is via the fetched
  // source_url (real, live imls.gov / nsf.gov program pages) — the CFDA numbers are illustrative only.

  it(
    "9. IMLS 21st Century Museum Professionals × NWACC → GROUNDED PURPOSE-FIT DEMOTE (no museum)",
    async () => {
      // Shannon's live audit: the engine scored a conditional 2 on ENTITY eligibility (an IHE is eligible),
      // but the program funds the MUSEUM WORKFORCE and NWACC has no museum. QA must FETCH the IMLS program
      // page, read the museum-workforce purpose, and SCORE the mismatch (demote) — not merely narrate it (the
      // exact "sees it, says it, doesn't score it" failure this fixes). Bar mirrors JAG #1 / VOCA #4: a
      // GROUNDED demote in the majority of runs; the fail-safe (no adverse without a grounded fetch) is HARD.
      const results = await runN(RUNS, () =>
        runIntelReview(
          card({
            fit_score: 2,
            proposed_role: "Prime",
            why_this_org: ["Institution of higher education; entity-eligible for the program."],
            reasoning_context: { fit_score_derivation: "IHEs are eligible; scored a conditional 2 on entity eligibility." },
          }),
          grant({
            title: "21st Century Museum Professionals Program",
            funder: "Institute of Museum and Library Services",
            assistance_listings: [{ number: "45.301", program_title: "21st Century Museum Professionals" }],
            program_type: "Competitive Grant",
            eligible_entity_types: ["institutions of higher education", "museums", "nonprofit organizations"],
            source_url: "https://www.imls.gov/find-funding/funding-opportunities/grant-programs/21st-century-museum-professionals-program",
          }),
          nwacc(),
          { discovery: true, narrative: true },
        ),
      );
      const demoted = results.map((r) => r.verdict === "demote");
      const grounded = results.map((r) => r.fetched.some((f) => f.ok));
      const reasoned = results.map((r) => /museum/i.test(r.summary));
      // A demote from the engine's 2 must actually LOWER the score (Shannon's point: score it, don't narrate).
      const scoreDropped = results.map((r) => r.verdict !== "demote" || (r.qa_fit_score != null && r.qa_fit_score < 2));
      console.log("[intel-eval] 21MP verdicts:", results.map((r) => `${r.verdict}${r.qa_fit_score != null ? `→${r.qa_fit_score}` : ""}`).join(", "));
      console.log("[intel-eval] 21MP summaries:", results.map((r) => r.summary));
      for (const r of results) {
        if (r.verdict === "demote" || r.verdict === "flag") {
          expect.soft(r.fetched.some((f) => f.ok), "an adverse 21MP verdict must rest on a grounded .gov fetch (fail-safe)").toBe(true);
        }
      }
      expect.soft(majority(grounded), "should fetch + ground on the IMLS museum-program page in the majority of runs").toBe(true);
      expect.soft(majority(demoted), "the museum-workforce purpose mismatch (no museum) must be SCORED (demote), not just narrated, in the majority of runs").toBe(true);
      expect.soft(scoreDropped.every(Boolean), "a 21MP demote must actually lower the score below the engine's 2").toBe(true);
      expect.soft(majority(reasoned), "the 21MP demote summary should name the museum purpose it grounded on").toBe(true);
      // REFUTE-CLEAN (Codex #496 P1): under AUTO_INTEL_APPLY_BROAD (ON) buildQaPatch auto-applies a demote
      // ONLY when refute_survived===true; a refute-unclean demote is staff-held and NEVER lowers the live
      // score. A purpose-fit demote's client-side fact ("no museum") is not on the .gov page, so without the
      // client context now passed to the refute this would fail — catching the false-green where the proposal
      // demotes but every broad-apply projection is rejected.
      const demotedRuns9 = results.filter((r) => r.verdict === "demote");
      const refuteClean9 = demotedRuns9.map((r) => r.refute_survived === true);
      console.log("[intel-eval] 21MP refute_survived:", results.map((r) => String(r.refute_survived)).join(", "));
      expect.soft(demotedRuns9.length === 0 || majority(refuteClean9), "a 21MP demote must be REFUTE-CLEAN (refute_survived===true) in the majority of demote runs — else broad apply staff-holds it and the live score never drops").toBe(true);
    },
    RUNS * 240_000,
  );

  it(
    "10. IMLS National Leadership Grants for Libraries × NWACC → GROUNDED PURPOSE-FIT DEMOTE (has a library, not the funded national research)",
    async () => {
      // The SUBTLER miss (why generic-nexus misses it and it must live in QA): NWACC HAS a library, so the
      // broad "library" nexus is entailed — but NLG-L funds NATIONAL-IMPACT, replicable, applied-research
      // library innovation, which a community-college library doing routine local service does not do.
      // "Has a library" ≠ "does the funded national research." Grounded on the imls.gov program page, which
      // states the replicable / national-implementation / applied-research purpose.
      const results = await runN(RUNS, () =>
        runIntelReview(
          card({
            fit_score: 2,
            proposed_role: "Prime",
            why_this_org: ["Institution of higher education with a library; entity-eligible for the program."],
            reasoning_context: { fit_score_derivation: "IHEs / libraries are eligible; scored a conditional 2 — the college has a library." },
          }),
          grant({
            title: "National Leadership Grants for Libraries",
            funder: "Institute of Museum and Library Services",
            assistance_listings: [{ number: "45.312", program_title: "National Leadership Grants" }],
            program_type: "Competitive Grant",
            eligible_entity_types: ["libraries", "institutions of higher education", "nonprofit organizations"],
            source_url: "https://www.imls.gov/find-funding/funding-opportunities/grant-programs/national-leadership-grants-for-libraries",
          }),
          nwacc(),
          { discovery: true, narrative: true },
        ),
      );
      const demoted = results.map((r) => r.verdict === "demote");
      const grounded = results.map((r) => r.fetched.some((f) => f.ok));
      const scoreDropped = results.map((r) => r.verdict !== "demote" || (r.qa_fit_score != null && r.qa_fit_score < 2));
      const reasoned = results.map((r) => /national|research|replicab|innovation|field-wide|leadership|scal/i.test(r.summary));
      console.log("[intel-eval] NLG-L verdicts:", results.map((r) => `${r.verdict}${r.qa_fit_score != null ? `→${r.qa_fit_score}` : ""}`).join(", "));
      console.log("[intel-eval] NLG-L summaries:", results.map((r) => r.summary));
      for (const r of results) {
        if (r.verdict === "demote" || r.verdict === "flag") {
          expect.soft(r.fetched.some((f) => f.ok), "an adverse NLG-L verdict must rest on a grounded .gov fetch (fail-safe)").toBe(true);
        }
      }
      expect.soft(majority(grounded), "should fetch + ground on the IMLS NLG-L program page in the majority of runs").toBe(true);
      expect.soft(majority(demoted), "the 'has a library != does the funded national research' mismatch must be SCORED (demote) in the majority of runs").toBe(true);
      expect.soft(scoreDropped.every(Boolean), "an NLG-L demote must actually lower the score below the engine's 2").toBe(true);
      expect.soft(majority(reasoned), "the NLG-L demote summary should name the national-impact / research purpose it grounded on").toBe(true);
      // REFUTE-CLEAN (Codex #496 P1) — same gate as case 9: under broad apply only a refute-clean demote
      // auto-applies, so a demote here must survive the (now client-context-aware) refute to lower the score.
      const demotedRuns10 = results.filter((r) => r.verdict === "demote");
      const refuteClean10 = demotedRuns10.map((r) => r.refute_survived === true);
      console.log("[intel-eval] NLG-L refute_survived:", results.map((r) => String(r.refute_survived)).join(", "));
      expect.soft(demotedRuns10.length === 0 || majority(refuteClean10), "an NLG-L demote must be REFUTE-CLEAN (refute_survived===true) in the majority of demote runs — else broad apply staff-holds it and the live score never drops").toBe(true);
    },
    RUNS * 240_000,
  );

  it(
    "11. IMLS Laura Bush 21st Century Librarian × NWACC → NOT DEMOTED (genuine library-workforce overlap — the no-false-demote control)",
    async () => {
      // The control Shannon designated (LB21 is correctly a conditional 2). LB21 funds the LIBRARY workforce —
      // developing library staff and services — which a college that employs library staff can genuinely
      // pursue. GENUINE purpose overlap, NOT a categorical mismatch, so QA must NOT demote it. This is the
      // boundary that fails if the purpose-fit class over-fires on "not the strongest fit."
      const results = await runN(RUNS, () =>
        runIntelReview(
          card({
            fit_score: 2,
            proposed_role: "Prime",
            why_this_org: ["Institution of higher education with a library and library staff; entity-eligible."],
            reasoning_context: { fit_score_derivation: "IHEs / libraries are eligible; scored a conditional 2 on genuine library-workforce overlap." },
          }),
          grant({
            title: "Laura Bush 21st Century Librarian Program",
            funder: "Institute of Museum and Library Services",
            assistance_listings: [{ number: "45.313", program_title: "Laura Bush 21st Century Librarian" }],
            program_type: "Competitive Grant",
            eligible_entity_types: ["libraries", "institutions of higher education", "nonprofit organizations"],
            source_url: "https://www.imls.gov/find-funding/funding-opportunities/grant-programs/laura-bush-21st-century-librarian-program",
          }),
          nwacc(),
          { discovery: false },
        ),
      );
      const notDemoted = results.map((r) => r.verdict !== "demote");
      console.log("[intel-eval] LB21 verdicts:", results.map((r) => `${r.verdict}${r.qa_fit_score != null ? `→${r.qa_fit_score}` : ""}`).join(", "));
      console.log("[intel-eval] LB21 summaries:", results.map((r) => r.summary));
      expect.soft(majority(notDemoted), "LB21 funds the library workforce — a college with a library has genuine purpose overlap; QA must not demote a genuine (if conditional) fit").toBe(true);
    },
    RUNS * 200_000,
  );

  it(
    "12. NSF Advanced Technological Education × NWACC → NOT DEMOTED (performs the funded work, just a smaller competitor — the competitive-weakness control)",
    async () => {
      // THE case that fails if QA demotes on COMPETITIVE WEAKNESS instead of CATEGORICAL mismatch. Two-year
      // community colleges are the CORE ATE audience and technician/workforce education is NWACC's core
      // mission — it genuinely PERFORMS the funded activity. A smaller, less-resourced applicant than a large
      // college is still a real applicant: "weaker applicant" is NOT "does not do this work." QA must AFFIRM
      // (not demote). A different funder (NSF) than the IMLS cases, so the affirm cohort isn't one program.
      const results = await runN(RUNS, () =>
        runIntelReview(
          card({
            fit_score: 2,
            proposed_role: "Prime",
            why_this_org: ["Two-year community college running associate-degree technical/workforce programs; core ATE audience."],
            reasoning_context: { fit_score_derivation: "Two-year IHEs are the core ATE audience; scored a conditional 2." },
          }),
          grant({
            title: "Advanced Technological Education (ATE)",
            funder: "National Science Foundation",
            assistance_listings: [{ number: "47.076", program_title: "Advanced Technological Education" }],
            program_type: "Competitive Grant",
            eligible_entity_types: ["two-year institutions of higher education", "community colleges", "universities"],
            source_url: "https://www.nsf.gov/funding/opportunities/ate-advanced-technological-education",
          }),
          nwacc(),
          { discovery: false },
        ),
      );
      const notDemoted = results.map((r) => r.verdict !== "demote");
      console.log("[intel-eval] ATE verdicts:", results.map((r) => `${r.verdict}${r.qa_fit_score != null ? `→${r.qa_fit_score}` : ""}`).join(", "));
      console.log("[intel-eval] ATE summaries:", results.map((r) => r.summary));
      expect.soft(majority(notDemoted), "NWACC genuinely performs technician education (ATE's core purpose) — a smaller competitor is a real applicant; QA must NOT demote on competitive weakness").toBe(true);
    },
    RUNS * 200_000,
  );
});
