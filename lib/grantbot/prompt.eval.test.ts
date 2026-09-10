import { describe, it, expect } from "vitest";
import type Anthropic from "@anthropic-ai/sdk";
import { getAnthropicClient, MODEL } from "@/lib/anthropic";
import { assembleSystem, buildSystemPrompt, framePastedContent } from "./prompt";
import type { ContextPack } from "./context-pack";

// ── GrantBot reasoning eval — the deduce+label+gate carve-out ──────────────────────────────────────
//
// MODEL-IN-THE-LOOP. NOT a unit test; MUST NOT run in the normal suite or the sandbox — it makes real
// (paid) calls to MODEL. Skipped unless RUN_GRANTBOT_EVAL=1 AND ANTHROPIC_API_KEY is present. Run it in
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
// over a minimal synthetic ContextPack and calls MODEL directly with one user turn — no Supabase, no
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
async function callGrantBot(pack: ContextPack, userText: string): Promise<string> {
  const prompt = buildSystemPrompt({ pack });
  const system = assembleSystem(prompt);
  const anthropic = getAnthropicClient();
  const res = await anthropic.messages.create({
    model: MODEL,
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
      const named = answers.map((a) =>
        /farmers market promotion|\bFMPP\b|local food promotion|\bLFPP\b|\bFMLFPP\b|\bUSDA\b|agricultural marketing service|\bAMS\b/i.test(a),
      );
      const labelled = answers.map((a) =>
        /unconfirmed|can(?:'|no)?t confirm|not confirmed|best guess|\blikely\b|\bprobably\b|would need to (?:verify|confirm)|educated guess|my guess|can(?:'|no)?t be (?:sure|certain)|tentativ/i.test(a),
      );
      const gated = answers.map((a) =>
        /\blink\b|official source|\bNOFO\b|\bverify\b|\bconfirm\b|grants\.gov|the (?:actual|real|official)|before (?:i|we) (?:pull|analyz|analys)|need (?:the|to)/i.test(a),
      );
      expect.soft(majority(named), "must NAME the most likely program (FMPP / USDA AMS) from thin context, not stop at 'no platform record'").toBe(true);
      expect.soft(majority(labelled), "the named program must be explicitly labelled an unconfirmed deduction").toBe(true);
      expect.soft(majority(gated), "must still gate: name what it would take to confirm before pulling/analysing the NOFO").toBe(true);
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
      expect.soft(majority(gated), "confidence about WHICH program it is must not license stating its deadline/award as fact — it still gates on the official source").toBe(true);
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
      expect.soft(majority(usesVerified), "must use the SAM-verified legal name, never the derived/distilled one").toBe(true);
      expect.soft(majority(flagsDerived), "must flag that the derived profile name conflicts and needs correcting — never assert an unverified legal name as fact").toBe(true);
    },
    RUNS * 120_000,
  );
});
