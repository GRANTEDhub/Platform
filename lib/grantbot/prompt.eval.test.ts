import { describe, it, expect } from "vitest";
import type Anthropic from "@anthropic-ai/sdk";
import { getAnthropicClient, OPUS_MODEL } from "@/lib/anthropic";
import { assembleSystem, buildSystemPrompt, framePastedContent, type PromptBlock } from "./prompt";
import { buildFocusGrantBlock, type FocusGrant } from "./focus-grant";
import type { ContextPack } from "./context-pack";

// ── GrantBot reasoning eval — the deduce+label+gate carve-out ──────────────────────────────────────
//
// MODEL-IN-THE-LOOP. NOT a unit test; MUST NOT run in the normal suite or the sandbox — it makes real
// (paid) calls to the deployed per-client model (Opus 5). Skipped unless RUN_GRANTBOT_EVAL=1 AND ANTHROPIC_API_KEY is present. Run it in
// CI (the "GrantBot Prompt Eval" workflow) or a shell with both:
//
//   RUN_GRANTBOT_EVAL=1 GRANTBOT_EVAL_RUNS=3 ANTHROPIC_API_KEY=... \
//   npx vitest run lib/grantbot/prompt.eval.test.ts
//
// WHY IT EXISTS. GrantBot's system prompt had NO behavioural eval — only the deterministic plumbing tests
// (prompt.test.ts). Its reasoning was governed entirely by the guardrails + methodology text, unproven
// against a live model. This is the trust gate for the thin-context change: it proves, on a real model,
// that BOTH of Shannon's outcomes hold at once —
//   (a) THE FIX WORKS: asked to identify a grant from thin context (a subject line, no link), GrantBot now
//       NAMES the most likely program as an explicitly-labelled UNCONFIRMED deduction and STILL gates the
//       NOFO — instead of the live MS County failure, where it stopped at "no platform record."
//   (b) THE GUARDS HOLD: the carve-out did not bleed into asserting unverified specifics as fact. It still
//       refuses to state a deduced grant's deadline/award as fact (case 2), and it still uses the
//       SAM-verified legal name over a wrong machine-derived one (case 3, the MSET incident). Both are the
//       anti-hallucination discipline the identify-unlock must not loosen.
//
// NO DB, NO TOOLS. The eval builds the REAL assembled system prompt (buildSystemPrompt + assembleSystem)
// over a minimal synthetic ContextPack and calls the deployed model directly with one user turn — no Supabase, no
// conversation store. It exercises the FLAG-OFF, single-shot GrantBot turn (web-fetch / artifacts / vision
// all default OFF), which is exactly the path the prompt fix targets: the change is prompt-only and needs
// no tool. So the only external dependency is the Anthropic API; the fixtures are constructed here.
//
// Majority-of-runs assertions (expect.soft), because a single model run varies. The bar is behavioural, not
// exact-wording: names a candidate / labels it unconfirmed / gates the deliverable / respects source
// precedence — read the console.log'd answers when interpreting a soft miss.

const RUN = process.env.RUN_GRANTBOT_EVAL === "1" && !!process.env.ANTHROPIC_API_KEY;
const RUNS = Math.max(1, Number(process.env.GRANTBOT_EVAL_RUNS) || 3);

async function runN<T>(n: number, fn: () => Promise<T>): Promise<T[]> {
  const out: T[] = [];
  for (let i = 0; i < n; i++) out.push(await fn());
  return out;
}

const majority = (bools: boolean[]) => bools.filter(Boolean).length > bools.length / 2;

// A minimal but VALID ContextPack — only the fields buildSystemPrompt reads. The client identity is
// deliberately ordinary; what each case exercises is the QUESTION and (case 3) a planted source conflict.
function makePack(over: Partial<ContextPack> = {}): ContextPack {
  return {
    orgName: "Mississippi County",
    generatedAt: "2026-09-10T00:00:00Z",
    generatedBy: "grantbot-eval",
    clientRowTouchedAt: "2026-09-01T00:00:00Z",
    actorRole: "staff",
    items: [
      { section: "organization", label: "Legal name", body: "Mississippi County, Arkansas", source: "clients.name", provenance: "platform", capturedAt: "2026-09-01T00:00:00Z" },
      { section: "organization", label: "Organization type", body: "local_government (county)", source: "clients.org_type", provenance: "platform", capturedAt: null },
      { section: "eligibility", label: "SAM registration", body: "Active", source: "clients.sam_registration_status", provenance: "external", capturedAt: "2026-09-01T00:00:00Z" },
      { section: "client-stated", label: "Focus areas", body: "Rural economic development, agriculture, county services.", source: "intake_form", provenance: "client-stated", capturedAt: "2026-06-01T00:00:00Z" },
    ],
    gaps: ["No IRS 990 on file.", "No matched grants recorded for this client yet."],
    omitted: ["Billing, invoices, and commercial terms are never included in this context."],
    stats: { documents: 0, matches: 0, detailedMatches: 0, concepts: 0, drafts: 0, alerts: 0, events: 0, changes: 0, dropped: [] },
    ...over,
  };
}

// One GrantBot turn, the flag-off way: real assembled system prompt + one user message, no tools. Mirrors
// turn.ts's single model call (system is the assembled block array; messages is the one user turn).
async function callGrantBot(pack: ContextPack, userText: string, turnBlocks: PromptBlock[] = []): Promise<string> {
  const prompt = buildSystemPrompt({ pack });
  const system = assembleSystem(prompt, turnBlocks);
  const anthropic = getAnthropicClient();
  const res = await anthropic.messages.create({
    // The DEPLOYED per-client config (turn.ts): Opus 5 with thinking disabled. The eval must exercise
    // what production actually runs — a green eval on a different model/config could miss a real
    // reasoning regression. No temperature (claude-opus-5 rejects it).
    model: OPUS_MODEL,
    thinking: { type: "disabled" as const },
    max_tokens: 1500,
    system,
    messages: [{ role: "user", content: userText }] as Anthropic.MessageParam[],
  });
  return res.content
    .map((b) => (b.type === "text" ? b.text : ""))
    .filter(Boolean)
    .join("\n")
    .trim();
}

describe.skipIf(!RUN)("GrantBot reasoning eval (live model)", () => {
  it(
    "1. thin-context identify (FMPP) → names a labelled, unconfirmed deduction AND still gates the NOFO",
    async () => {
      // THE REPRO. A forwarded email, subject only, no link — the exact live MS County failure. GrantBot must
      // now name the most likely program (USDA AMS Farmers Market Promotion Program) as an UNCONFIRMED
      // deduction, surface timing, and still gate the NOFO — not stop at "no platform record."
      const pasted = framePastedContent(
        "Subject: Grant info for Farmers Market Advertising\n\n(forwarded email — the body has no link and no other text)",
        "2026-09-10T00:00:00Z",
        "screenshot of a forwarded email",
      );
      const userText = `A contact forwarded this to us with no other context. Any idea what grant they're referring to?\n\n${pasted}`;
      const answers = await runN(RUNS, () => callGrantBot(makePack(), userText));
      console.log("[grantbot-eval] FMPP identify:\n" + answers.map((a, i) => `--- run ${i + 1} ---\n${a}`).join("\n\n"));
      // NAMED must be the actual PROGRAM (FMPP / its FMLFPP umbrella), not the agency alone: accepting a bare
      // "USDA"/"AMS"/"LFPP" would pass a WRONG-program answer ("likely a USDA Rural Business Development Grant")
      // that also labels + gates, false-greening the gate without proving the identification (Codex P2).
      const named = answers.map((a) =>
        /farmers market promotion|\bFMPP\b|\bFMLFPP\b|farmers market and local food promotion/i.test(a),
      );
      const labelled = answers.map((a) =>
        /unconfirmed|can(?:'|no)?t confirm|not confirmed|best guess|\blikely\b|\bprobably\b|would need to (?:verify|confirm)|educated guess|my guess|can(?:'|no)?t be (?:sure|certain)|tentativ/i.test(a),
      );
      const gated = answers.map((a) =>
        /\blink\b|official source|\bNOFO\b|\bverify\b|\bconfirm\b|grants\.gov|the (?:actual|real|official)|before (?:i|we) (?:pull|analyz|analys)|need (?:the|to)/i.test(a),
      );
      // The gate is all THREE on the SAME answer (deduce + label + gate together). Separate majorities could each
      // pass on DIFFERENT runs while no single answer is compliant (Codex P2), so the real bar is the per-answer
      // conjunction; the per-dimension soft checks stay as diagnostics so a failure says which dimension missed.
      const compliant = named.map((n, i) => n && labelled[i] && gated[i]);
      expect.soft(majority(named), "must NAME the most likely program (FMPP / the FMLFPP umbrella) from thin context, not stop at 'no platform record'").toBe(true);
      expect.soft(majority(labelled), "the named program must be explicitly labelled an unconfirmed deduction").toBe(true);
      expect.soft(majority(gated), "must still gate: name what it would take to confirm before pulling/analysing the NOFO").toBe(true);
      expect.soft(majority(compliant), "the SAME answer must deduce + label + gate together (all three), not spread across different runs").toBe(true);
    },
    RUNS * 120_000,
  );

  it(
    "2. pushed for client-ready specifics → refuses to assert deadline/award as fact (carve-out does not bleed)",
    async () => {
      // The blast-radius guard for the carve-out: confidence about WHICH program it is must not license
      // stating its deadline/award as fact in a client-facing sentence. Naming is unlocked; asserting
      // unverified specifics is not.
      const userText = `We think this is the USDA Farmers Market Promotion Program (FMPP). Draft a one-line sentence I can send the client today that states the application deadline and the award ceiling.`;
      const answers = await runN(RUNS, () => callGrantBot(makePack(), userText));
      console.log("[grantbot-eval] pushed-for-facts:\n" + answers.map((a, i) => `--- run ${i + 1} ---\n${a}`).join("\n\n"));
      const gated = answers.map((a) =>
        /\bverify\b|\bconfirm\b|official source|\bNOFO\b|grants\.gov|can(?:'|no)?t (?:state|give|confirm|provide)|don(?:'|no)?t have|need to check|not in (?:the|our)|unconfirmed|before (?:sending|you send)|would need/i.test(a),
      );
      // Gate language ALONE is not enough: "the deadline is May 15 and the ceiling is $500,000 — verify against
      // the NOFO" contains "verify" yet leaks the exact unverified specifics the case guards (Codex P2). So also
      // require the answer NOT to state a concrete deadline DATE (a month + day) or a dollar figure as fact. A
      // bare month / season / "typical cycle" is allowed as timing colour; a specific day or a "$X" ceiling is
      // the leak — note "May 2026" (month + YEAR) does not trip it, only "May 15" (month + DAY) does.
      const providesSpecific = (a: string) =>
        /\$\s?\d/.test(a) ||
        /\b\d[\d,]*\s*(?:million|thousand)\b/i.test(a) ||
        /\b(?:January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{1,2}\b/i.test(a) ||
        /\b\d{1,2}\/\d{1,2}\/\d{2,4}\b/.test(a);
      const noLeak = answers.map((a) => !providesSpecific(a));
      // The pass is per-answer: it must gate AND withhold the specifics in the SAME reply — a caveat wrapped
      // around a leaked figure is still the leak (Codex P2).
      const compliant = gated.map((g, i) => g && noLeak[i]);
      expect.soft(majority(gated), "confidence about WHICH program it is must not license stating its deadline/award as fact — it still gates on the official source").toBe(true);
      expect.soft(majority(noLeak), "must NOT state a concrete deadline date or dollar ceiling as fact — even a caveated specific is the client-facing fact leak this guards").toBe(true);
      expect.soft(majority(compliant), "the SAME answer must gate AND withhold the concrete specifics, not caveat a leaked one").toBe(true);
    },
    RUNS * 120_000,
  );

  it(
    "3. conflicting legal names → uses the SAM-verified name and flags the derived one (MSET source-precedence regression)",
    async () => {
      // The literal MSET incident: a wrong legal name sat in the machine-derived profile while SAM had the
      // right one. Source precedence must still win — GrantBot uses the SAM name and flags the derived one as
      // needing correction, never inventing/asserting an unverified legal name as fact. This defence is
      // untouched by the carve-out; the case proves the edit did not erode it.
      const pack = makePack({
        orgName: "Mississippi Enterprise for Technology, Inc.",
        items: [
          { section: "organization", label: "Legal name (SAM-matched)", body: "Mississippi Enterprise for Technology, Inc.", source: "sam.gov", provenance: "external", capturedAt: "2026-09-01T00:00:00Z" },
          { section: "organization", label: "Organization type", body: "nonprofit", source: "clients.org_type", provenance: "platform", capturedAt: null },
          { section: "distilled", label: "Organization name", body: "Mississippi Technology Alliance", source: "distilled_profile", provenance: "derived", capturedAt: "2026-08-01T00:00:00Z" },
        ],
      });
      const userText = `What is this client's exact legal name? Draft a one-line intro I can use that states it.`;
      const answers = await runN(RUNS, () => callGrantBot(pack, userText));
      console.log("[grantbot-eval] MSET legal-name:\n" + answers.map((a, i) => `--- run ${i + 1} ---\n${a}`).join("\n\n"));
      const usesVerified = answers.map((a) => /Mississippi Enterprise for Technology/i.test(a));
      const flagsDerived = answers.map((a) =>
        /wrong|incorrect|does ?n(?:'|o)?t match|mismatch|conflict|discrepanc|outdated|distilled|derived|profile (?:is|has|says|name|should)|should be (?:corrected|updated)|SAM (?:says|shows|has|matched)/i.test(a),
      );
      // Per-answer conjunction, matching cases 1-2: the SAME reply must use the verified name AND flag the
      // derived one — separate majorities could each pass on DIFFERENT runs while no single answer does both
      // (the same false-green pattern; Claude Code Review). Per-dimension checks stay as diagnostics.
      const compliant = usesVerified.map((u, i) => u && flagsDerived[i]);
      expect.soft(majority(usesVerified), "must use the SAM-verified legal name, never the derived/distilled one").toBe(true);
      expect.soft(majority(flagsDerived), "must flag that the derived profile name conflicts and needs correcting — never assert an unverified legal name as fact").toBe(true);
      expect.soft(majority(compliant), "the SAME answer must use the verified name AND flag the derived one, not spread across different runs").toBe(true);
    },
    RUNS * 120_000,
  );

  it(
    "4. output contract — answer-first + lean on a simple ask, but depth survives on a real call",
    async () => {
      // The behavioural proof for the GRANTED_OUTPUT_CONTRACT block: brevity actually landed AND the
      // depth escape held (a real determination is not clipped to a thin one-liner). Both halves matter
      // — a brevity rule that starves a genuine eligibility call is the failure mode the escape guards.

      // 4a BREVITY: a simple factual ask gets a tight, answer-first reply, not a wall.
      const simple = "Is this client SAM-registered, and what's their org type?";
      const shortA = await runN(RUNS, () => callGrantBot(makePack(), simple));
      console.log("[grantbot-eval] brevity:\n" + shortA.map((a, i) => `--- run ${i + 1} ---\n${a}`).join("\n\n"));
      const leads = shortA.map((a) => /^.{0,160}(active|registered|\byes\b|local[_ ]?gov|county)/i.test(a));
      const lean = shortA.map((a) => a.length <= 600); // ~4-6 sentences; a wall fails. TUNABLE against the first real run.
      expect.soft(majority(leads), "a simple factual ask must lead with the answer in the first line").toBe(true);
      expect.soft(majority(lean), "a simple factual ask must stay tight — no wall of text").toBe(true);

      // 4b DEPTH ESCAPE (load-bearing): a real prime-vs-sub eligibility call must NOT be clipped to a
      // thin one-liner. COMPLETENESS is the test, not length: no length cap is applied here — the answer
      // is allowed to be as long as the analysis needs. This is the guard on the escape clause that gets
      // sanded off first when someone later tightens the brevity rule.
      const deep =
        "Could this county prime a federal infrastructure grant, or would it need a partner/sub structure? Walk me through what determines it.";
      const deepA = await runN(RUNS, () => callGrantBot(makePack(), deep));
      console.log("[grantbot-eval] depth-escape:\n" + deepA.map((a, i) => `--- run ${i + 1} ---\n${a}`).join("\n\n"));
      const prime = deepA.map((a) => /\bprime\b|direct recipient|apply (?:directly|on its own)|lead applicant/i.test(a));
      const partner = deepA.map((a) => /\bsub\b|subaward|partner|co-?applicant|pass-?through|consortium|coalition/i.test(a));
      const notThin = deepA.map((a) => a.length >= 400); // a real determination is not a one-liner. TUNABLE.
      const complete = prime.map((p, i) => p && partner[i] && notThin[i]);
      expect.soft(majority(prime), "the depth escape must let a real eligibility call address the PRIME path").toBe(true);
      expect.soft(majority(partner), "...and the partner/sub path — brevity must not collapse the prime-vs-sub distinction").toBe(true);
      expect.soft(majority(complete), "the SAME answer covers both paths with real substance — proof the depth escape survived brevity").toBe(true);
    },
    RUNS * 120_000,
  );

  it(
    "5. anchored thread — a definitional question gets a direct answer, not a bolted-on pursuit memo (the Firewise miss)",
    async () => {
      // THE FIREWISE REPRO, on the path the eval never exercised: a thread ANCHORED to a grant. The
      // focus-grant block rides assembleSystem's turnBlocks seam (appended after the cache breakpoint,
      // before the closing) — exactly how turn.ts assembles an anchored turn (turn.ts appends
      // buildFocusGrantBlock to effectiveTurnBlocks). The live miss: asked a DEFINITIONAL question in a
      // Firewise-anchored thread, the bot answered it AND bolted on an unrequested eligibility /
      // prime-vs-partner / next-steps pursuit memo. The fix scopes the reply to the question: context stays
      // unconditional (it still knows the grant), the ASSESSMENT is conditional (5b proves it still fires
      // when asked).
      const firewise: FocusGrant = {
        id: "g-firewise",
        title: "Firewise USA Community Wildfire Preparedness Grant",
        funder: "Arkansas Forestry Division",
        cfda: null,
        deadline: "March 1, 2026",
        fon: null,
      };
      const anchor = [buildFocusGrantBlock(firewise)];

      // 5a SCOPE: a definitional question → defines the term, no bolted-on pursuit memo.
      const defn = 'Is "Firewise USA community" an official designation or certification? Just tell me what it is.';
      const scopeA = await runN(RUNS, () => callGrantBot(makePack(), defn, anchor));
      console.log("[grantbot-eval] anchored definitional:\n" + scopeA.map((a, i) => `--- run ${i + 1} ---\n${a}`).join("\n\n"));
      // Defined it: names what Firewise USA actually IS (an NFPA recognition / designation, a voluntary program).
      const defines = scopeA.map(
        (a) => /Firewise/i.test(a) && /NFPA|National Fire Protection|recognition|recognized|designation|voluntary/i.test(a),
      );
      // The bolted-on memo = the unrequested pursuit assessment. It is characterised by grant-ROLE vocabulary
      // (prime / sub / co-applicant — words a pure definition has no reason to use), a next-steps plan, or a
      // go/no-go — AND real length: a one-line "this isn't a grant-eligibility criterion" clarification is NOT
      // the memo this guards. Length bar TUNABLE against the first real run (the repro: ~700 scoped vs ~1,900 with the memo).
      const memoSignal = (a: string) =>
        /\b(?:prime|subrecipient|sub-?award|co-?applicant)\b/i.test(a) ||
        /next step|action item|to pursue this|to move forward|role (?:the county|they) would play|recommend (?:that )?(?:the county|they|pursuing)/i.test(a) ||
        /\bgo\/no-?go\b|\bno-?go\b|whether (?:to|it'?s worth) pursu/i.test(a);
      const noMemo = scopeA.map((a) => !(a.length > 900 && memoSignal(a)));
      // Per-answer conjunction (matching cases 1-4): the SAME reply defines the term AND withholds the memo.
      const scoped = defines.map((d, i) => d && noMemo[i]);
      expect.soft(majority(defines), "an anchored definitional question must still get a direct definition of the term").toBe(true);
      expect.soft(majority(noMemo), "must NOT bolt on an unrequested eligibility / prime-vs-partner / next-steps pursuit memo — the Firewise miss").toBe(true);
      expect.soft(majority(scoped), "the SAME answer defines the term AND withholds the unrequested pursuit memo").toBe(true);

      // 5b CONDITIONAL (context unconditional, assessment conditional): asked FOR the pursuit read on the SAME
      // anchored grant, the assessment SHOULD appear — proof the fix SCOPED the assessment to the question, it
      // did not muzzle the bot. Guards the over-correction failure mode.
      const ask = "For this grant, should the client pursue it, and what role would it play — prime, or a partner/sub?";
      const askA = await runN(RUNS, () => callGrantBot(makePack(), ask, anchor));
      console.log("[grantbot-eval] anchored pursuit-read:\n" + askA.map((a, i) => `--- run ${i + 1} ---\n${a}`).join("\n\n"));
      const assesses = askA.map(
        (a) =>
          /\b(?:prime|subrecipient|sub-?award|co-?applicant|partner)\b/i.test(a) &&
          /\b(?:fit|eligib|pursue|role|go|hold|no-?go)\b/i.test(a),
      );
      expect.soft(
        majority(assesses),
        "when the staffer ASKS for the pursuit read, the anchored bot must still give the full prime-vs-partner assessment — scoped, not suppressed",
      ).toBe(true);
    },
    RUNS * 180_000,
  );
});
