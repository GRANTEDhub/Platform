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
// TWO COHORTS, because apply-mode writes the verdict to the card and PR A LOOSENED the grounding guard
// (host-grounding + refute, no verbatim quote), so the eval must prove BOTH directions before the flag
// flips: (DEMOTE cohort) QA lowers the genuinely-wrong matches, and (AFFIRM cohort) QA leaves the
// genuinely-good matches UNTOUCHED — the over-demote guard, which is the real risk of a looser guard.
// Six cases — [D] = demote cohort (catches the wrong matches), [A] = affirm cohort (leaves the good
// matches untouched — the over-demote guard), [F] = fail-safe:
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
//   4. [F] VOCA-discovery-FAIL-SAFE (INTEL_WEB_SEARCH_ENABLED) — a nonprofit victim-services org scored a
//      confident direct 3 on VOCA Victim Assistance (CFDA 16.575), a FORMULA grant to the states where
//      local/nonprofit providers are SUBGRANTEES through the state VOCA administering agency, not direct
//      federal applicants. The IDEAL is a web-search-discovered, grounded demote to state-subgrantee — but
//      on a LIVE handed OVC page the model tends to fetch it and not search, and the subgrant rule lives on
//      a sub-page the refute can't confirm from the landing page, so the demote honestly falls to
//      `unverified`. Per the accepted call (the seed/discovery URLs rot; grounding on live formula pages is
//      flaky), that is FINE: the bar is SAFETY — QA must never AFFIRM this subgrant-only nonprofit as a
//      clean prime, and no adverse verdict may land without a grounded fetch. Discovery / grounded-demote
//      are LOGGED for inspection, not gated; landing the demote on unseeded formula programs is follow-on
//      work (the discovery nudge). The demote that MUST land is the seeded JAG case (#1).
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
// Cases 5-6 run discovery:false — they are not formula programs, so a formula note never fires; keeping
// discovery off makes the affirm result flag-independent and keeps the pass to a single fetch (fast).
//
// Majority-of-runs assertions (expect.soft), because a single Opus run varies. The bar is the feature's
// philosophy: adverse ONLY when web-grounded; never over-demote a clear direct recipient. The AFFIRM
// cohort (cases 2, 5, 6) is the guard that PR A's looser grounding did not open an over-demote hole.

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

async function runN<T>(n: number, fn: () => Promise<T>): Promise<T[]> {
  // Small serial loop — the eval is low-volume and a live model; no need to hammer concurrently.
  const out: T[] = [];
  for (let i = 0; i < n; i++) out.push(await fn());
  return out;
}

const majority = (bools: boolean[]) => bools.filter(Boolean).length > bools.length / 2;

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
      const clean = demoteRuns.map(
        (r) => !r.narrative || FORBIDDEN_NARRATIVE_MARKERS.every((m) => !r.narrative!.toLowerCase().includes(m)),
      );
      // LENGTH CAP (visual): the prompt targets ~175 words / ~1,000 chars — a client card, not a memo. The
      // eval bar allows a small overage (≤1,100) since it is a model target, and logs the actual lengths.
      const lengths = demoteRuns.map((r) => r.narrative?.length ?? 0);
      console.log("[intel-eval] JAG-county narrative lengths:", lengths.join(", "));
      const withinCap = demoteRuns.map((r) => !r.narrative || r.narrative.length <= 1100);
      expect.soft(demoteRuns.length === 0 || majority(narrated), "a grounded demote should carry a client narrative in the majority of runs").toBe(true);
      expect.soft(demoteRuns.length === 0 || majority(faithful), "the narrative must preserve the grounded hard fact, not soften it (rule a)").toBe(true);
      expect.soft(clean.every(Boolean), "the narrative must carry NO internal-framing / scoring-machinery language (rule b)").toBe(true);
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
      const notDemoted = results.map((r) => r.verdict !== "demote");
      expect.soft(majority(notDemoted), "a state IS a direct JAG recipient — QA must not demote it").toBe(true);
      // Step C: the narrative rides an APPLIED DEMOTE only. A genuine affirm (or any non-demote) carries no
      // client narrative — the card keeps its engine paragraph. (Guards against the field leaking onto a match
      // QA did NOT change.)
      for (const r of results) {
        if (r.verdict !== "demote") expect.soft(r.narrative, "a non-demote verdict must carry no client narrative").toBeNull();
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
    "4. VOCA × nonprofit, discovery ON → fail-safe (never wrongly affirm a subgrant-only nonprofit; adverse only when grounded)",
    async () => {
      // 16.575 is formula-tagged but UNSEEDED. The IDEAL is a web-SEARCH-discovered, grounded demote to
      // state-subgrantee — but on a LIVE handed OVC page the model often fetches it and never searches, and
      // the subgrant rule lives on a sub-page the refute can't confirm from the landing page, so the demote
      // honestly falls to `unverified`. Per the accepted call, that is FINE: the bar here is the SAFETY
      // property (never wrongly affirm this nonprofit as a clean prime; no adverse without a grounded fetch),
      // not that the demote lands. Discovery / grounded-demote are logged for inspection, not gated —
      // demote-landing on unseeded formula programs is follow-on work (the discovery nudge), not a flip gate.
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
            // A real, live OVC .gov funding landing page (verified 200, 2026-08-27); the SUBGRANT/formula
            // reality it must confirm lives on the program's authoritative pages, which the pass has to
            // search for (nothing is seeded). The prior /program/victims-of-crime-act-voca/overview URL
            // 404'd, so the pass had no fetchable starting point.
            source_url: "https://ovc.ojp.gov/funding",
          }),
          client({ name: "Hope Victim Services", org_type: "nonprofit", location_state: "AR" }),
          { discovery: true },
        ),
      );
      const notAffirmed = results.map((r) => r.verdict !== "affirm");
      const adverse = results.map((r) => r.verdict === "demote" || r.verdict === "flag");
      console.log("[intel-eval] VOCA-discovery searches:", results.map((r) => r.searched.length).join(", "));
      console.log("[intel-eval] VOCA-discovery verdicts:", results.map((r) => `${r.verdict}${r.qa_fit_score != null ? `→${r.qa_fit_score}` : ""}`).join(", "));
      console.log("[intel-eval] VOCA-discovery grounded:", results.map((r) => r.fetched.some((f) => f.ok)).join(", "));
      console.log("[intel-eval] VOCA-discovery summaries:", results.map((r) => r.summary));
      // Fail-safe (HARD, every run): no adverse verdict without a grounded fetch. This is the safety gate.
      for (const r of results) {
        if (r.verdict === "demote" || r.verdict === "flag") {
          expect.soft(r.fetched.some((f) => f.ok), "adverse VOCA verdict must rest on a grounded .gov fetch (fail-safe)").toBe(true);
        }
      }
      // SAFETY (majority): a subgrant-only nonprofit is never AFFIRMED as a clean prime — it is either
      // demoted-when-grounded or honestly unverified, never green-lit. (Demote-landing itself is logged
      // above, not gated — see the header: it needs the discovery nudge, follow-on work.)
      expect.soft(majority(notAffirmed), "QA must never affirm a subgrant-only VOCA nonprofit as a clean prime").toBe(true);
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
});
