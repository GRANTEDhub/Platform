import { describe, it, expect } from "vitest";
import { runIntelReview, type IntelCard } from "./intel-review";
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
// .gov source. Four cases, matching the plan:
//
//   1. JAG-county-DEMOTE (discovery ON) — Mississippi County (AR, local_government) scored a confident
//      direct-recipient 3 on Byrne-JAG Local (CFDA 16.738). An AR county is a disparate / "asterisk"
//      jurisdiction on the JAG local allocation list and cannot prime a direct application. Runs with
//      discovery ON, the way the flag-on feature actually runs: fetch-only + the STATIC seed URL could not
//      ground a demote (the seed points at the prior-year AR allocation PDF while the open NOFO is the
//      current year, so the model correctly failed SAFE to unverified rather than guess). Discovery closes
//      that gap — it SEARCHES for the current-year Arkansas JAG allocation table, then FETCHes and grounds a
//      DEMOTE. Asserts search fired + a grounded adverse verdict.
//
//   2. JAG-state-AFFIRM    — the State of Arkansas (state_government, the State Administering Agency)
//      on the SAME program IS a direct JAG recipient. QA must NOT over-demote a genuine direct
//      recipient. This is the carve-out that proves the pass discriminates rather than blanket-demotes.
//
//   3. no-source-UNVERIFIED — a card whose only "source" is unreachable (non-.gov, unseeded CFDA). An
//      adverse verdict is STRUCTURALLY impossible without a successful fetch (finalizeIntel's grounding
//      guard), so the verdict must NOT be demote/flag. Proves fail-safe end-to-end on the live path.
//
//   4. VOCA-discovery-DEMOTE (INTEL_WEB_SEARCH_ENABLED) — a nonprofit victim-services org scored a
//      confident direct 3 on VOCA Victim Assistance (CFDA 16.575). VOCA is a FORMULA grant to the states;
//      local/nonprofit providers are SUBGRANTEES through the state VOCA administering agency, not direct
//      federal applicants. 16.575 is formula-TAGGED but has NO seeded allocation URL (allocation-sources
//      only seeds 16.738), so the pass has no handed URL for the subgrant reality — it must web-SEARCH to
//      discover the authoritative .gov source, then FETCH and ground it. This is the discovery deliverable:
//      it exercises the path the seed map alone cannot reach. Runs with discovery:true; cases 2-3 run
//      discovery:false so the seed-map + fail-safe guarantees are proven independent of the flag. It asserts
//      web_search was ACTUALLY invoked (r.searched) — not merely that a fetch of the handed URL succeeded —
//      so the flip gate can't false-green without exercising discovery. If case 4 comes back "unverified"
//      or with 0 searches, that is the FINDING (discovery didn't fire / couldn't ground the subgrant page).
//
// Majority-of-runs assertions (expect.soft), because a single Opus run varies. The bar is the feature's
// philosophy: adverse ONLY when web-grounded; never over-demote a clear direct recipient.

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
    "1. JAG × Mississippi County, discovery ON → DEMOTE, web-grounded (asterisk/disparate, can't prime)",
    async () => {
      // Discovery ON, the way the flag-on feature actually runs. Fetch-only + the static seed URL could
      // not ground a demote here (the seed points at the prior-year AR allocation PDF while the open NOFO
      // is the current year, so the model correctly failed SAFE to unverified rather than guess) — the very
      // gap discovery closes: it can SEARCH for the current-year Arkansas JAG allocation table and ground on it.
      const results = await runN(RUNS, () =>
        runIntelReview(
          card(),
          grant(),
          client({ name: "Mississippi County", org_type: "local_government", location_state: "AR" }),
          { discovery: true },
        ),
      );
      const searchedUsed = results.map((r) => r.searched.length > 0);
      const adverse = results.map((r) => r.verdict === "demote" || r.verdict === "flag");
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
      expect.soft(majority(searchedUsed), "discovery should search for the current-year Arkansas JAG allocation table").toBe(true);
      expect.soft(majority(grounded), "should reach + ground a .gov allocation source in the majority of runs").toBe(true);
      expect.soft(majority(adverse), "should demote/flag a county that cannot prime JAG (asterisk/disparate jurisdiction)").toBe(true);
      expect.soft(majority(reasoned), "the Intel summary should name the allocation reality").toBe(true);
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
          { discovery: false },
        ),
      );
      console.log("[intel-eval] JAG-state verdicts:", results.map((r) => r.verdict).join(", "));
      const notDemoted = results.map((r) => r.verdict !== "demote");
      expect.soft(majority(notDemoted), "a state IS a direct JAG recipient — QA must not demote it").toBe(true);
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
    "4. VOCA × nonprofit, discovery ON → web-SEARCH reaches the unseeded subgrant reality and grounds it",
    async () => {
      // 16.575 is formula-tagged but UNSEEDED (no allocation-sources URL), so the pass must SEARCH to find
      // the authoritative VOCA structure, then FETCH a .gov page and ground on it. The discovery proof is
      // a GROUNDED fetch on a program with no handed URL — impossible fetch-only. Adverse is the expected
      // read (subgrantee-through-the-state), but the hard guarantee is still the fail-safe: no adverse
      // without a grounded fetch.
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
            // A real, stable OVC .gov landing page; the SUBGRANT/formula reality it must confirm lives on
            // the program's authoritative pages, which the pass has to search for (nothing is seeded).
            source_url: "https://ovc.ojp.gov/program/victims-of-crime-act-voca/overview",
          }),
          client({ name: "Hope Victim Services", org_type: "nonprofit", location_state: "AR" }),
          { discovery: true },
        ),
      );
      const searchedUsed = results.map((r) => r.searched.length > 0);
      const grounded = results.map((r) => r.fetched.some((f) => f.ok));
      const adverse = results.map((r) => r.verdict === "demote" || r.verdict === "flag");
      const reasoned = results.map((r) => /subgrant|sub-grant|through the state|state (voca )?administering|pass.?through|not.*direct/i.test(r.summary));
      console.log("[intel-eval] VOCA-discovery searches:", results.map((r) => r.searched.length).join(", "));
      console.log("[intel-eval] VOCA-discovery verdicts:", results.map((r) => `${r.verdict}${r.qa_fit_score != null ? `→${r.qa_fit_score}` : ""}`).join(", "));
      console.log("[intel-eval] VOCA-discovery summaries:", results.map((r) => r.summary));
      // Fail-safe (HARD, every run): no adverse verdict without a grounded fetch.
      for (const r of results) {
        if (r.verdict === "demote" || r.verdict === "flag") {
          expect.soft(r.fetched.some((f) => f.ok), "adverse VOCA verdict must rest on a grounded .gov fetch (fail-safe)").toBe(true);
        }
      }
      // DISCOVERY PROOF (majority): the pass actually INVOKED web_search. Without this the case could pass
      // on a fetch of the handed OVC URL alone and never exercise discovery — a false-green flip gate.
      expect.soft(majority(searchedUsed), "discovery must actually invoke web_search on an UNSEEDED formula program — 0 searches means the gate never exercised discovery").toBe(true);
      // ...and grounds a .gov source for a program with NO seeded URL.
      expect.soft(majority(grounded), "web-search discovery should reach + ground a .gov source for an UNSEEDED formula program — 'unverified' here is the finding to inspect").toBe(true);
      expect.soft(majority(adverse), "a nonprofit that can only subgrant VOCA through the state should be demoted/flagged").toBe(true);
      expect.soft(majority(reasoned), "the summary should name the subgrant / state-administering reality").toBe(true);
    },
    RUNS * 240_000,
  );
});
