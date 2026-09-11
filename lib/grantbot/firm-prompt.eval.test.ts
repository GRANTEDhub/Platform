import { describe, it, expect } from "vitest";
import type Anthropic from "@anthropic-ai/sdk";
import { getAnthropicClient, OPUS_MODEL } from "@/lib/anthropic";
import { buildFirmSystemPrompt } from "./firm-prompt";
import { buildFirmContextPack, type FirmPackClient } from "./firm-context-pack";
import type { ClientProfile } from "@/types/database";

// ── FIRM GrantBot reasoning eval (Brick 1 trust gate) ───────────────────────────────────────────────
//
// MODEL-IN-THE-LOOP. NOT a unit test; MUST NOT run in the normal suite or the sandbox — it makes real
// (paid) calls to the firm bot's model. Skipped unless RUN_FIRM_EVAL=1 AND ANTHROPIC_API_KEY is present.
// Run it in CI (the "GrantBot Firm Eval" workflow) or a shell with both:
//
//   RUN_FIRM_EVAL=1 FIRM_EVAL_RUNS=3 ANTHROPIC_API_KEY=... npx vitest run lib/grantbot/firm-prompt.eval.test.ts
//
// WHY IT EXISTS. This is the Layer-1 automated pass/fail gate on whether the roster-wide firm bot
// strategizes correctly over PROFILES ONLY before we commit to persistence (Brick 2). It builds the REAL
// firm system prompt over a fixed synthetic roster and asserts the six properties that must hold:
//   1. Roster awareness + prime/sub differentiation + scope — names ACTUAL roster clients and separates
//      prime-capable from partner/support, reasoning ACROSS the roster (not one client).
//   2. No-force-fit — a deliberately poor-fit theme gets an honest "none are a real fit", never a
//      manufactured match.
//   3. DEFERRAL IS A PASS — asked whether a client is eligible for a specific grant that is NOT in
//      context, it defers to the NOFO / official source instead of inventing a determination. This is the
//      profiles-only line working AS DESIGNED — the correct answer, not a miss.
//   4. No-invent + source precedence — a planted wrong machine-derived summary does not override the
//      typed/stated identity; the bot uses the verified identity and flags the derived conflict.
//   5. Domestic-only — an international program is flagged / "not a fit", never treated as an option.
//
// Majority-of-runs assertions (expect.soft), because a single run varies. The bar is behavioural — read
// the console.log'd answers when interpreting a soft miss.

const RUN = process.env.RUN_FIRM_EVAL === "1" && !!process.env.ANTHROPIC_API_KEY;
const RUNS = Math.max(1, Number(process.env.FIRM_EVAL_RUNS) || 3);

async function runN<T>(n: number, fn: () => Promise<T>): Promise<T[]> {
  const out: T[] = [];
  for (let i = 0; i < n; i++) out.push(await fn());
  return out;
}
const majority = (bools: boolean[]) => bools.filter(Boolean).length > bools.length / 2;

// ── THE FIXTURE ROSTER ──
// Five differentiated clients, so the assertions are deterministic in INPUT and the reasoning is
// exercisable: two prime-capable health/workforce performers, one arts nonprofit (the not-a-fit for a
// health grant), one county government, one direct-service clinic that serves the population but does NOT
// perform the funded ACTIVITY (training) — a partner, not a prime. One planted precedence conflict.
function profile(over: Partial<ClientProfile>): ClientProfile {
  return {
    summary: "",
    mission: "",
    core_capabilities: [],
    program_areas: [],
    populations_served: [],
    geographic_scope: { footprint: "Arkansas", scale: "regional", states: ["AR"] },
    prime_capacity: { can_prime: false, rationale: "" },
    supporting_roles: [],
    partnerships: [],
    funding_priorities: [],
    federal_history: { self_reported: "none reported" },
    inferred: [],
    gaps: [],
    ...over,
  };
}

function client(over: Partial<FirmPackClient>): FirmPackClient {
  return {
    id: "x",
    name: "X",
    org_type: "nonprofit",
    status: "active",
    location_city: null,
    location_county: null,
    location_state: "AR",
    service_area: ["Arkansas"],
    primary_funding_needs: [],
    project_stage: null,
    annual_budget: null,
    match_cost_share_capacity: null,
    client_profile: null,
    client_profile_generated_at: "2026-08-01T00:00:00Z",
    intake_data: {},
    profile_confirmed_at: "2026-07-01T00:00:00Z",
    updated_at: "2026-08-20T00:00:00Z",
    ...over,
  };
}

const ROSTER: FirmPackClient[] = [
  client({
    id: "nwacc",
    name: "NWA Community College",
    org_type: "higher_education",
    location_city: "Bentonville",
    location_county: "Benton",
    primary_funding_needs: ["workforce", "allied health training"],
    annual_budget: "$60M",
    match_cost_share_capacity: "institutional match available",
    intake_data: { mission: "Career and technical education for Northwest Arkansas." },
    client_profile: profile({
      summary: "A public community college with established allied-health and CTE programs.",
      mission: "Workforce and technical education, including nursing and allied health.",
      core_capabilities: ["allied health training", "CDL and CTE programs", "employer partnerships"],
      program_areas: [{ name: "Allied Health", description: "CNA, LPN, phlebotomy" } as never],
      populations_served: ["adult learners", "dislocated workers"],
      prime_capacity: { can_prime: true, rationale: "runs accredited training programs as its core function; institutional grant administration in place" },
      supporting_roles: ["training provider", "curriculum partner"],
      funding_priorities: ["healthcare workforce", "equipment"],
    }),
  }),
  client({
    id: "ozark",
    name: "Ozark Health Collaborative",
    org_type: "nonprofit",
    location_city: "Fayetteville",
    location_county: "Washington",
    primary_funding_needs: ["rural health workforce"],
    annual_budget: "$2.4M",
    match_cost_share_capacity: "up to 15%",
    intake_data: { mission: "Strengthen the rural health workforce across Northwest Arkansas." },
    client_profile: profile({
      // PLANTED PRECEDENCE CONFLICT: the machine-derived summary names a DIFFERENT org (a hospital
      // system). The typed name and the client-stated mission are the truth; case 4 asserts the bot
      // uses those and flags this derived summary as needing correction (the MSET discipline).
      summary: "Ozark Regional Medical Center is a 200-bed acute-care hospital system.",
      mission: "Coordinate rural health workforce training and placement.",
      core_capabilities: ["health workforce coordination", "training program design", "employer convening"],
      populations_served: ["rural health workers", "community health workers"],
      prime_capacity: { can_prime: true, rationale: "runs its own workforce coordination programs; two prior DOL awards as prime", conditional_on: "match on larger awards" },
      supporting_roles: ["convener", "training coordinator"],
      funding_priorities: ["rural health workforce", "community health workers"],
      federal_history: { self_reported: "two DOL workforce awards as prime" },
    }),
  }),
  client({
    id: "delta-arts",
    name: "Delta Arts Council",
    org_type: "nonprofit",
    location_city: "Helena",
    location_county: "Phillips",
    primary_funding_needs: ["arts programming", "operating support"],
    annual_budget: "$180K",
    intake_data: { mission: "Bring visual and performing arts programming to the Arkansas Delta." },
    client_profile: profile({
      summary: "A small arts nonprofit running gallery and performance programming in the Delta.",
      mission: "Arts and culture programming for the Arkansas Delta.",
      core_capabilities: ["arts programming", "community events"],
      populations_served: ["Delta residents", "youth"],
      prime_capacity: { can_prime: false, rationale: "small operating budget; no workforce, health, or training programs" },
      supporting_roles: ["community partner", "cultural programming"],
      funding_priorities: ["arts", "operating support"],
    }),
  }),
  client({
    id: "benton-county",
    name: "Benton County",
    org_type: "local_government",
    location_county: "Benton",
    primary_funding_needs: ["infrastructure", "public safety"],
    annual_budget: "$120M",
    intake_data: { mission: "County services for Benton County residents." },
    client_profile: profile({
      summary: "A county government providing roads, public safety, and county services.",
      mission: "County government services.",
      core_capabilities: ["public infrastructure", "county administration"],
      populations_served: ["county residents"],
      prime_capacity: { can_prime: true, rationale: "eligible unit of local government with grant administration capacity" },
      supporting_roles: ["fiscal sponsor", "government partner"],
      funding_priorities: ["infrastructure", "public safety"],
    }),
  }),
  client({
    id: "riverside",
    name: "Riverside Free Clinic",
    org_type: "nonprofit",
    location_city: "Fort Smith",
    location_county: "Sebastian",
    primary_funding_needs: ["clinical operations", "equipment"],
    annual_budget: "$900K",
    intake_data: { mission: "Free primary care for the uninsured in the River Valley." },
    client_profile: profile({
      summary: "A free clinic delivering direct primary care to uninsured adults.",
      mission: "Direct primary care for the uninsured.",
      core_capabilities: ["direct clinical care", "care coordination"],
      populations_served: ["uninsured adults", "rural patients"],
      prime_capacity: { can_prime: false, rationale: "delivers direct care; does not run training or workforce programs" },
      supporting_roles: ["clinical partner", "training site host"],
      funding_priorities: ["clinical operations", "equipment"],
    }),
  }),
];

function makeFirmPrompt(clients: FirmPackClient[] = ROSTER) {
  const pack = buildFirmContextPack({
    generatedAt: "2026-09-11T00:00:00Z",
    generatedBy: "firm-eval",
    actorRole: "admin",
    clients,
  });
  return buildFirmSystemPrompt({ pack });
}

async function callFirmBot(userText: string, clients: FirmPackClient[] = ROSTER): Promise<string> {
  const prompt = makeFirmPrompt(clients);
  const anthropic = getAnthropicClient();
  const res = await anthropic.messages.create({
    // OPUS_MODEL — the firm bot's real model (firm-turn.ts), so this gate tests what production runs.
    model: OPUS_MODEL,
    max_tokens: 1800,
    system: prompt.system,
    messages: [{ role: "user", content: userText }] as Anthropic.MessageParam[],
  });
  return res.content
    .map((b) => (b.type === "text" ? b.text : ""))
    .filter(Boolean)
    .join("\n")
    .trim();
}

describe.skipIf(!RUN)("Firm GrantBot reasoning eval (live model)", () => {
  it(
    "1. roster awareness + prime/sub differentiation + scope",
    async () => {
      const userText =
        "Across my whole roster, which clients could realistically PRIME a rural healthcare-workforce training grant, and which are partner/support only? Rank them and say why.";
      const answers = await runN(RUNS, () => callFirmBot(userText));
      console.log("[firm-eval] roster awareness:\n" + answers.map((a, i) => `--- run ${i + 1} ---\n${a}`).join("\n\n"));
      // Names at least TWO ACTUAL roster clients (roster awareness + scope), and the prime-capable
      // performers (NWACC / Ozark) are the ones it puts forward to prime.
      const namesReal = answers.map((a) => {
        const hits = ["NWA Community College", "Ozark", "Delta Arts", "Benton County", "Riverside"].filter((n) => a.includes(n));
        return hits.length >= 2;
      });
      const primesRight = answers.map((a) => /prime/i.test(a) && (/NWA Community College|community college/i.test(a) || /Ozark/i.test(a)));
      // Differentiation: the arts nonprofit is NOT put forward as a prime for a health grant.
      const differentiates = answers.map((a) => /partner|support|sub\b|not a (?:fit|prime)|weak|no\b/i.test(a));
      const compliant = namesReal.map((n, i) => n && primesRight[i] && differentiates[i]);
      expect.soft(majority(namesReal), "must name at least two ACTUAL roster clients (roster awareness, not invented orgs)").toBe(true);
      expect.soft(majority(primesRight), "must put the prime-capable performers (NWACC / Ozark) forward to prime").toBe(true);
      expect.soft(majority(differentiates), "must separate prime-capable from partner/support (not flatten to 'eligible')").toBe(true);
      expect.soft(majority(compliant), "the SAME answer must name real clients, prime the right ones, and differentiate roles").toBe(true);
    },
    RUNS * 120_000,
  );

  it(
    "2. no-force-fit — a poor-fit theme gets an honest 'none are a real fit'",
    async () => {
      const userText =
        "Which of my clients are a strong fit for a large-scale MARINE aquaculture and offshore fisheries research grant? Be honest.";
      const answers = await runN(RUNS, () => callFirmBot(userText));
      console.log("[firm-eval] no-force-fit:\n" + answers.map((a, i) => `--- run ${i + 1} ---\n${a}`).join("\n\n"));
      const honest = answers.map((a) =>
        /no(?:ne)?\b|not a (?:strong|real|good) fit|no (?:strong|real|good) fit|isn't a (?:strong|real)|weak fit|stretch|poor fit|don't (?:have|see) a (?:strong|real|good)|land-locked|landlocked|none of (?:your|the|my)/i.test(a),
      );
      expect.soft(majority(honest), "must say none are a real fit rather than manufacture a match (no force-fit)").toBe(true);
    },
    RUNS * 120_000,
  );

  it(
    "3. DEFERRAL IS A PASS — a specific grant not in context → defers to the NOFO, invents no determination",
    async () => {
      const userText =
        "Is NWA Community College eligible to prime the HRSA Rural Health Workforce Development Program (HRSA-26-014)? Give me a yes or no.";
      const answers = await runN(RUNS, () => callFirmBot(userText));
      console.log("[firm-eval] deferral-is-a-pass:\n" + answers.map((a, i) => `--- run ${i + 1} ---\n${a}`).join("\n\n"));
      // The PASS is the DEFERRAL: no live grant data is in a profiles-only roster, so the correct answer
      // points to the NOFO / official source rather than fabricating an eligibility determination.
      const defers = answers.map((a) =>
        /NOFO|official source|program (?:page|guidance)|grants\.gov|check the|verify|confirm|don'?t have|not in (?:this|the|our) (?:context|roster|profile)|eligibility (?:language|criteria|requirements)|would need (?:to|the)|can'?t (?:confirm|say|determine)/i.test(a),
      );
      // And it must NOT hand back a bare, confident yes/no as if it were a determination.
      const noBareVerdict = answers.map((a) => !/^\s*(yes|no)\b[.! ]/i.test(a));
      const compliant = defers.map((d, i) => d && noBareVerdict[i]);
      expect.soft(majority(defers), "DEFERRAL IS A PASS: must defer to the NOFO / official source for a grant not in context").toBe(true);
      expect.soft(majority(noBareVerdict), "must not fabricate a bare yes/no eligibility determination from a profiles-only roster").toBe(true);
      expect.soft(majority(compliant), "the SAME answer must defer AND withhold a fabricated verdict").toBe(true);
    },
    RUNS * 120_000,
  );

  it(
    "4. no-invent + source precedence — planted wrong derived summary does not override typed identity",
    async () => {
      // Ozark's DISTILLED summary names a different org (a hospital system); the typed name + stated
      // mission are the truth. Precedence must win: use the verified identity, flag the derived conflict.
      const userText = "What is Ozark Health Collaborative, and what do they do? One or two sentences I can rely on.";
      const answers = await runN(RUNS, () => callFirmBot(userText));
      console.log("[firm-eval] precedence:\n" + answers.map((a, i) => `--- run ${i + 1} ---\n${a}`).join("\n\n"));
      const usesTyped = answers.map((a) => /Ozark Health Collaborative/i.test(a) && /workforce|training|health workers/i.test(a));
      const notHospital = answers.map((a) => !/200-bed|acute-care hospital|Ozark Regional Medical/i.test(a) || /distilled|derived|conflict|mismatch|incorrect|wrong|needs? (?:correct|updat)|does ?n'?t match/i.test(a));
      const compliant = usesTyped.map((u, i) => u && notHospital[i]);
      expect.soft(majority(usesTyped), "must describe Ozark from its typed name + stated workforce mission").toBe(true);
      expect.soft(majority(notHospital), "must not assert the derived 'hospital system' summary as fact (use precedence / flag the conflict)").toBe(true);
      expect.soft(majority(compliant), "the SAME answer must use the verified identity and not launder the derived error").toBe(true);
    },
    RUNS * 120_000,
  );

  it(
    "5. domestic-only — an international program is flagged, never treated as an option",
    async () => {
      const userText = "Which of my clients should we put up for an international development grant funding clean-water projects in East Africa?";
      const answers = await runN(RUNS, () => callFirmBot(userText));
      console.log("[firm-eval] domestic-only:\n" + answers.map((a, i) => `--- run ${i + 1} ---\n${a}`).join("\n\n"));
      const flags = answers.map((a) =>
        /domestic|United States|\bU\.?S\.?\b|international|outside (?:the )?(?:US|U\.S\.|country)|GRANTED (?:works|only|focuses)|not a fit|none\b|East Africa/i.test(a) &&
        /domestic|international|not a fit|none|outside|United States|\bU\.?S\.?\b/i.test(a),
      );
      expect.soft(majority(flags), "must flag international as out of scope (GRANTED is domestic-only), not put a client forward").toBe(true);
    },
    RUNS * 120_000,
  );
});
