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
// .gov source. Three cases, matching the plan:
//
//   1. JAG-county-DEMOTE   — Mississippi County (AR, local_government) scored a confident direct-
//      recipient 3 on Byrne-JAG Local (CFDA 16.738). An AR county is a disparate / "asterisk"
//      jurisdiction on the JAG local allocation list and cannot prime a direct application. QA should
//      DEMOTE (adverse), grounded on the BJA allocation page. If it comes back "unverified", that is
//      the FINDING: fetch-only could not reach/parse the allocation table (or the seed URL is stale) —
//      see lib/grants/allocation-sources.ts and confirm the URL, then decide whether web SEARCH is a
//      later build. This case failing "unverified" is informative, not a code bug.
//
//   2. JAG-state-AFFIRM    — the State of Arkansas (state_government, the State Administering Agency)
//      on the SAME program IS a direct JAG recipient. QA must NOT over-demote a genuine direct
//      recipient. This is the carve-out that proves the pass discriminates rather than blanket-demotes.
//
//   3. no-source-UNVERIFIED — a card whose only "source" is unreachable (non-.gov, unseeded CFDA). An
//      adverse verdict is STRUCTURALLY impossible without a successful fetch (finalizeIntel's grounding
//      guard), so the verdict must NOT be demote/flag. Proves fail-safe end-to-end on the live path.
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
    "1. JAG × Mississippi County → DEMOTE, web-grounded (asterisk/disparate, can't prime)",
    async () => {
      const results = await runN(RUNS, () =>
        runIntelReview(
          card(),
          grant(),
          client({ name: "Mississippi County", org_type: "local_government", location_state: "AR" }),
          {},
        ),
      );
      const adverse = results.map((r) => r.verdict === "demote" || r.verdict === "flag");
      const grounded = results.map((r) => r.fetched.some((f) => f.ok));
      const reasoned = results.map((r) => /asterisk|disparate|through the state|state administering|cannot (prime|apply)|allocation|not.*direct/i.test(r.summary));
      // Informative surfacing of what actually happened, so a failing run says WHY.
      console.log("[intel-eval] JAG-county verdicts:", results.map((r) => `${r.verdict}${r.qa_fit_score != null ? `→${r.qa_fit_score}` : ""}`).join(", "));
      console.log("[intel-eval] JAG-county summaries:", results.map((r) => r.summary));
      expect.soft(majority(grounded), "fetch-only must reach the BJA source in the majority of runs — else confirm the seed URL / fetchability (this is the fetch-only finding)").toBe(true);
      expect.soft(majority(adverse), "should demote/flag a county that cannot prime JAG — 'unverified' here means fetch-only could not ground it").toBe(true);
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
          {},
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
          {},
        ),
      );
      console.log("[intel-eval] no-source verdicts:", results.map((r) => r.verdict).join(", "));
      for (const r of results) {
        expect.soft(r.verdict === "demote" || r.verdict === "flag", "no adverse verdict is allowed without a grounded fetch").toBe(false);
      }
    },
    RUNS * 200_000,
  );
});
