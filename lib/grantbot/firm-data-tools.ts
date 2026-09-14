// The firm bot's federal-data wiring. It REUSES the per-client tools + executor + audit record
// verbatim (data-tools.ts — no rebuild): the three read-only lookups against USASpending.gov and
// SAM.gov, keyed by CFDA / org name / UEI, that only READ two fixed public .gov data APIs (no write,
// no internal reach). The firm surface adds only two things of its own, exactly like firm-web-fetch.ts:
//
//   1. Its OWN flag, GRANTBOT_FIRM_DATA_TOOLS_ENABLED, SEPARATE from the per-client
//      GRANTBOT_DATA_TOOLS_ENABLED — so the two bots' data reach is enabled independently (they are at
//      different maturity). Default OFF; off is byte-identical to today's firm bot (no data tools, no
//      data-tools instruction block — see firm-turn.ts).
//   2. Its OWN instruction block. The per-client DATA_TOOLS_INSTRUCTION_BLOCK's who-wins rule ends by
//      "SUPERSEDING" methodology.ts's pre-tool line — but the firm bot has NO methodology block (the
//      deliberate divergence; its v2 instructions already carry the "who actually wins" lateral read),
//      so that reference would dangle. The firm block ties the rule to his instructions instead. The
//      tools/executor are shared; only the framing is firm-specific.

import type { PromptBlock } from "@/lib/grantbot/prompt";

// Reuse the exact per-client tools + guarded executor + audit type. firm-turn imports these from HERE
// (one firm module) so the firm wiring reads like the firm-web-fetch wiring beside it.
export {
  PROGRAM_AWARDS_TOOL,
  PROGRAM_AWARDS_TOOL_NAME,
  ORG_HISTORY_TOOL,
  ORG_HISTORY_TOOL_NAME,
  SAM_ENTITY_TOOL,
  SAM_ENTITY_TOOL_NAME,
  executeDataTool,
  type DataLookupAuditRecord,
} from "@/lib/grantbot/data-tools";
import { PROGRAM_AWARDS_TOOL_NAME, ORG_HISTORY_TOOL_NAME, SAM_ENTITY_TOOL_NAME } from "@/lib/grantbot/data-tools";

// Off unless exactly "true". Read SERVER-SIDE, never NEXT_PUBLIC_. SEPARATE from the per-client flag so
// the two bots' data reach is independent. Default-off means today's firm bot is unchanged.
export function firmDataToolsEnabled(): boolean {
  return process.env.GRANTBOT_FIRM_DATA_TOOLS_ENABLED === "true";
}

// The firm data-tools instruction block. Appended AFTER the cache breakpoint (cacheable:false) and ONLY
// when the flag is on, so the flag-off firm system prompt is unchanged and existing caches are not
// busted — exactly like FIRM_FETCH_INSTRUCTION_BLOCK. Firm framing: it ties the mandatory who-wins call
// to his instructions' "who actually wins" lateral read (the firm bot has no methodology block for the
// per-client version's "SUPERSEDING" reference to point at).
export const FIRM_DATA_TOOLS_INSTRUCTION_BLOCK: PromptBlock = {
  kind: "data-tools",
  source: "lib/grantbot/firm-data-tools.ts",
  version: "2026-09-14.1",
  cacheable: false,
  text: [
    "FEDERAL DATA LOOKUPS — THREE READ-ONLY TOOLS",
    `Alongside your other tools, you have three read-only federal-data tools: ${PROGRAM_AWARDS_TOOL_NAME} (who actually won a program, by CFDA), ${ORG_HISTORY_TOOL_NAME} (an org's federal award history, by name), and ${SAM_ENTITY_TOOL_NAME} (an org's SAM.gov registration status). Each only READS a public U.S. federal data API (USASpending.gov, SAM.gov) — none can write, act, send, or reach anything internal, so the read-only rule stands in full.`,
    "",
    `WHO WINS → CALL THE TOOL, DON'T RECALL. Your method already reads who actually wins a program laterally rather than assuming from eligibility — ${PROGRAM_AWARDS_TOOL_NAME} IS that read. So when the question is who wins a grant, what type of applicant wins it, or who the recipients are — and you have or can ask for its CFDA — you MUST call ${PROGRAM_AWARDS_TOOL_NAME} and read the archetype off the ACTUAL winners. Do NOT answer a who-wins question from memory, and NEVER write "I pulled the winners from USASpending" or name any recipient unless you actually called the tool THIS turn — claiming federal data you did not fetch is a fabrication.`,
    "",
    `A national ${PROGRAM_AWARDS_TOOL_NAME} call (no state) gives the full winner picture — read the TYPE off it. When a client or prospect is anchored in a state, a SECOND state-scoped call for in-state precedent is a good lateral read: make it, then SYNTHESIZE both into one finished answer in the SAME turn. Never end a turn on "let me also check…" — if you have called the tools you need, write the answer now.`,
    "",
    "ENTITY-ELIGIBILITY IS NOT COMPETITIVENESS. SAM registration (lookup_sam_entity) is a gate — registered/active or not. Who wins (lookup_program_awards) is the competitive reality. Keep them distinct, and keep prime vs. partner/sub distinct: an org that resembles the sub-awardees on a program is a partner fit, not a prime fit. Never force-fit — if the winners are all large research universities or state agencies and the org is a county, say so plainly.",
    "",
    "A FAILED OR EMPTY LOOKUP IS A FACT, NEVER A GUESS. If a lookup returns nothing or could not run, report that as what it is (no federal record found / not SAM-registered under that name / the lookup could not run) and, if it matters, say what to check. Do NOT fill the gap from general knowledge, and do NOT announce a lookup you then leave undone — run it in this same turn or say you could not.",
    "",
    "Counts and dollar figures come from USASpending for 2019–present and can UNDERCOUNT (recent postings, sub-awards, a truncated fetch) — treat them as a floor and label award amounts as estimates. Keep the lookups themselves OUT of your reply: no 'let me look up', no tool names, no play-by-play — just the finished answer, or the plain could-not-find line.",
  ].join("\n"),
};
