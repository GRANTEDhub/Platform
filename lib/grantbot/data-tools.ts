// GrantBot's federal-data tools: three READ-ONLY lookups against USASpending.gov and SAM.gov, the
// data reach Shannon's GRANTED IntellEngine Claude project has and GrantBot did not. Same discipline
// as web-fetch (Brick B): the tool set is a server-side constant, the executors only READ public
// federal APIs (no write, no internal reach), and the whole thing is behind ONE flag that defaults
// OFF — off is byte-identical to the pre-data-tools turn (see turn.ts + tool-loop.ts).
//
// The invariant GrantBot holds is "no `tools` unless a flag, and then EXACTLY the allowlisted
// read-only ones." These three extend that set: they reach OUTWARD (like web-fetch) but only to two
// fixed, public .gov data APIs, keyed by CFDA / org name / UEI — never an arbitrary URL, never
// anything internal. They reuse the platform's OWN, already-shipped clients (lib/grants/usaspending,
// lib/grants/program-awards, lib/sam/client), so this file is wiring + framing, not new data access.
//
// WHY THESE THREE. The concrete failures that motivated this: a "what type of applicant usually wins
// this grant?" question (CFDA 20.284, MS County) stalled because the bot had no way to see who
// actually won the program; and past-performance / registration questions had the same gap. The three
// tools map to those exactly: who-wins (lookup_program_awards), an org's federal record
// (lookup_org_federal_history), and SAM registration status (lookup_sam_entity).
//
// PURE-TESTABLE. The data functions are INJECTED seams (opts.deps), so the formatting and the
// typed-gap discipline are unit-tested without a live model, a network, or the two .gov APIs. Not
// marked "server-only": its only real caller is turn.ts (server-only), so the egress stays
// server-side regardless.

import type { PromptBlock } from "@/lib/grantbot/prompt";
import { findProgramAwardees, checkPastPerformance, type ProgramAwardee, type USASpendingResult } from "@/lib/grants/usaspending";
import { lookupByUei, searchByNameState, isValidUei, SamError, type SamEntity } from "@/lib/sam/client";

// Off unless exactly "true" — same shape as grantbotWebFetchEnabled(). Read SERVER-SIDE, never
// NEXT_PUBLIC_, so flipping it is a config change (a redeploy binds it), and the default-off is the
// instant-revert guarantee: off == today. ONE flag gates all three tools (the artifacts pattern).
export function grantbotDataToolsEnabled(): boolean {
  return process.env.GRANTBOT_DATA_TOOLS_ENABLED === "true";
}

// How many distinct winners we hand the model for the who-wins archetype. Enough to read the TYPE of
// applicant off the list without flooding the context window; the full field is larger (findProgramAwardees
// aggregates the first ~100 awards into distinct orgs, recency-first).
const MAX_AWARDEES_SHOWN = 15;

// ── The tools, as server-side constants ──────────────────────────────────────────────────────────
export const PROGRAM_AWARDS_TOOL_NAME = "lookup_program_awards";
export const ORG_HISTORY_TOOL_NAME = "lookup_org_federal_history";
export const SAM_ENTITY_TOOL_NAME = "lookup_sam_entity";

export const PROGRAM_AWARDS_TOOL = {
  name: PROGRAM_AWARDS_TOOL_NAME,
  description:
    "Look up the organizations that ACTUALLY WON a federal program, by its Assistance Listing / CFDA number (e.g. \"20.284\"), from USASpending.gov (grants + cooperative agreements, 2019–present). Returns the distinct recipient organizations, most recent first, with each one's award count, total, and awarding agency — so you can judge WHAT TYPE of applicant wins (a state agency, a university, a large nonprofit, a county). Read-only. Leave state empty for the national picture; set state (2-letter) to check in-state precedent.",
  input_schema: {
    type: "object" as const,
    properties: {
      cfda: {
        description: "The Assistance Listing / CFDA number, e.g. \"20.284\". A string, or an array of strings if the grant lists several.",
      },
      state: {
        type: "string",
        description: "Optional 2-letter state code (e.g. \"AR\") to restrict to winners headquartered in that state. Omit for the national picture.",
      },
    },
    required: ["cfda"],
  },
} as const;

export const ORG_HISTORY_TOOL = {
  name: ORG_HISTORY_TOOL_NAME,
  description:
    "Look up an organization's FEDERAL grant history (past performance) from USASpending.gov by name — its award count, total dollars, and awarding agencies (grants + cooperative agreements, 2019–present). Use it to judge whether an org has prime-grant track record. Read-only. Name matching is approximate; zero results can mean 'no federal history' OR a name mismatch, and the result says which.",
  input_schema: {
    type: "object" as const,
    properties: {
      org_name: {
        type: "string",
        description: "The organization's name, as close to its legal/registered name as you have it.",
      },
    },
    required: ["org_name"],
  },
} as const;

export const SAM_ENTITY_TOOL = {
  name: SAM_ENTITY_TOOL_NAME,
  description:
    "Look up an organization's SAM.gov registration — active/expired status, expiration date, UEI, legal name, location. SAM registration is a precondition for receiving most federal funds, so this checks an eligibility gate, NOT competitiveness. Read-only. Provide a UEI for an exact lookup, or an org_name (with optional state) for a best-guess search.",
  input_schema: {
    type: "object" as const,
    properties: {
      org_name: { type: "string", description: "Organization name to search for (used when no UEI is given)." },
      state: { type: "string", description: "Optional 2-letter state code to narrow a name search." },
      uei: { type: "string", description: "A 12-character SAM UEI for an exact lookup, if known." },
    },
  },
} as const;

// The flag-gated instruction block. Appended AFTER the cache breakpoint (cacheable: false) and only
// when the flag is on, so it never enters the shared cached prefix — the flag-off system prompt is
// unchanged and existing conversations' prompt caches are not busted (the web-fetch discipline).
export const DATA_TOOLS_INSTRUCTION_BLOCK: PromptBlock = {
  kind: "data-tools",
  source: "lib/grantbot/data-tools.ts",
  version: "2026-09-14.2",
  cacheable: false,
  text: [
    "FEDERAL DATA LOOKUPS — THREE READ-ONLY TOOLS",
    `You have three read-only federal-data tools, in addition to any others named above: ${PROGRAM_AWARDS_TOOL_NAME} (who actually won a program, by CFDA), ${ORG_HISTORY_TOOL_NAME} (an org's federal award history, by name), and ${SAM_ENTITY_TOOL_NAME} (an org's SAM.gov registration status). Each only READS a public U.S. federal data API (USASpending.gov, SAM.gov) — none can write, act, send, or reach anything internal, so the READ-ONLY rule stands in full.`,
    "",
    `WHO WINS → CALL THE TOOL, DON'T RECALL. When a staffer asks who wins a grant, what type of applicant wins it, or who the recipients are — and you have or can ask for its CFDA — you MUST call ${PROGRAM_AWARDS_TOOL_NAME} and read the archetype off the ACTUAL winners. Do NOT answer a who-wins question from memory, and NEVER write "I pulled the winners from USASpending" or name any recipient unless you actually called the tool THIS turn — claiming federal data you did not fetch is a fabrication. Any earlier guidance to "name the archetype from your own knowledge" or to hand the staffer "a USASpending search on the CFDA" is SUPERSEDED here: you now HAVE that search — it is ${PROGRAM_AWARDS_TOOL_NAME} — so run it rather than describe it. This is GRANTED's method: verify against the authoritative federal record, never trust recollection.`,
    "",
    `A national ${PROGRAM_AWARDS_TOOL_NAME} call (no state) gives the full winner picture — read the TYPE off it. When the client is anchored in a state, a SECOND state-scoped call for in-state precedent is a good lateral read: make it, then SYNTHESIZE both into one finished answer in the SAME turn. Never end a turn on "let me also check…" — if you have called the tools you need, write the answer now.`,
    "",
    "ENTITY-ELIGIBILITY IS NOT COMPETITIVENESS. SAM registration (lookup_sam_entity) is a gate — registered/active or not. Who wins (lookup_program_awards) is the competitive reality. Keep them distinct, and keep prime vs. partner/sub distinct: a client that resembles the sub-awardees on a program is a partner fit, not a prime fit. Never force-fit — if the winners are all large research universities or state agencies and the client is a county, say so plainly.",
    "",
    "A FAILED OR EMPTY LOOKUP IS A FACT, NEVER A GUESS. If a lookup returns nothing or could not run, report that as what it is (no federal record found / not SAM-registered under that name / the lookup could not run) and, if it matters, say what to check. Do NOT fill the gap from general knowledge, and do NOT announce a lookup you then leave undone — run it in this same turn or say you could not.",
    "",
    "Counts and dollar figures come from USASpending for 2019–present and can UNDERCOUNT (recent postings, sub-awards, a truncated fetch) — treat them as a floor and label award amounts as estimates, per the org rules. Keep the lookups themselves OUT of your reply: no 'let me look up', no tool names, no play-by-play — just the finished answer, or the plain could-not-find line.",
  ].join("\n"),
};

// ── Audit record (stored as a non-text block; normalizeContent drops it on read) ──────────────────
export interface DataLookupAuditRecord {
  tool: string;
  query: string; // the normalized query (cfda(s) / org name / uei-or-name)
  ok: boolean; // a lookup that RAN and returned data
  count?: number; // rows returned when ok
  reason?: string; // present when !ok (no_data / bad_input / not_configured / rate_limit / upstream)
  at: string;
}

// Injected seams: the real data clients by default, fakes in tests.
export interface DataToolDeps {
  findProgramAwardees: typeof findProgramAwardees;
  checkPastPerformance: typeof checkPastPerformance;
  lookupByUei: typeof lookupByUei;
  searchByNameState: typeof searchByNameState;
}
const defaultDeps: DataToolDeps = { findProgramAwardees, checkPastPerformance, lookupByUei, searchByNameState };

// ── Input normalization ──────────────────────────────────────────────────────────────────────────
// The model passes `input: unknown`; each executor validates its own and returns a typed gap rather
// than throwing. CFDA arrives as a string or array; we keep non-empty trimmed tokens.
function normalizeCfdas(raw: unknown): string[] {
  const list = Array.isArray(raw) ? raw : [raw];
  const out: string[] = [];
  for (const v of list) {
    if (typeof v !== "string") continue;
    const t = v.trim();
    if (t) out.push(t);
  }
  return Array.from(new Set(out));
}

function usd(n: number): string {
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `$${Math.round(n / 1_000)}k`;
  return `$${Math.round(n)}`;
}

// ── Formatters (pure) ────────────────────────────────────────────────────────────────────────────
export function formatProgramAwards(cfdas: string[], state: string | undefined, awardees: ProgramAwardee[]): string {
  const scope = state ? ` headquartered in ${state.toUpperCase()}` : "";
  const label = `CFDA ${cfdas.join(", ")}`;
  if (awardees.length === 0) {
    return (
      `USASpending — no federal grant or cooperative-agreement awards found under ${label}${scope} (2019–present). ` +
      "This can mean the program is new/forecasted, awards are not yet posted, sub-awarded (so the prime is a pass-through), or the CFDA is wrong. " +
      "Report this as a gap — do NOT infer who wins from memory."
    );
  }
  const shown = awardees.slice(0, MAX_AWARDEES_SHOWN);
  const lines = shown.map((a) => {
    const total = a.total_awarded > 0 ? `, ${usd(a.total_awarded)} total` : "";
    const recent = a.most_recent_year ? `, most recent ${a.most_recent_year}` : "";
    const agency = a.agencies[0] ? ` (${a.agencies[0]})` : "";
    const st = a.state ? ` [${a.state}]` : "";
    return `- ${a.name}${st} — ${a.award_count} award${a.award_count === 1 ? "" : "s"}${total}${recent}${agency}`;
  });
  const more = awardees.length > shown.length ? `\n(+${awardees.length - shown.length} more distinct recipients not shown)` : "";
  return (
    `USASpending — winners of ${label}${scope} (grants + cooperative agreements, 2019–present). ` +
    `${awardees.length} distinct recipient organization${awardees.length === 1 ? "" : "s"}, most recent first:\n` +
    lines.join("\n") +
    more +
    "\n\nRead this list to judge WHAT TYPE of applicant wins (state agency / university / large nonprofit / county / tribe) and whether the client genuinely resembles them. Counts and totals are what USASpending shows for 2019–present and may undercount; treat them as a floor and label amounts as estimates."
  );
}

export function formatOrgHistory(result: USASpendingResult): string {
  if (!result.verified) {
    return `USASpending lookup for "${result.search_term}" could not run (${result.note ?? "unknown error"}) — treat past performance as unverified, do not guess.`;
  }
  if (!result.has_federal_grant_history) {
    return (
      `USASpending — NO federal grants or cooperative agreements found for "${result.search_term}" (2019–present). ` +
      "This is either a genuine past-performance gap or a name mismatch (try the exact legal name). " +
      "For a large prime award, a gap argues for an experienced co-applicant."
    );
  }
  const total = result.total_awarded > 0 ? `, ${usd(result.total_awarded)} total` : "";
  const agencies = result.agencies.slice(0, 3).join(", ");
  const recent = result.most_recent
    ? `. Most recent: ${result.most_recent.awarding_agency} (${(result.most_recent.start_date ?? "").slice(0, 4)}), ${usd(result.most_recent.award_amount ?? 0)}`
    : "";
  return (
    `USASpending — "${result.search_term}": ${result.award_count} federal grant${result.award_count === 1 ? "" : "s"}/cooperative agreement${result.award_count === 1 ? "" : "s"}${total} (2019–present). ` +
    `Agencies: ${agencies}${recent}. Counts/totals are a floor (undercounts recent postings and sub-awards); label amounts as estimates.`
  );
}

export function formatSamEntity(query: string, entities: SamEntity[]): string {
  if (entities.length === 0) {
    return (
      `SAM.gov — no entity found matching "${query}". ` +
      "This can mean the org is not SAM-registered (an eligibility gap for most federal funds) OR the search name differs from the legal name / UEI. Report which is more likely; do not assume registration."
    );
  }
  const lines = entities.slice(0, 4).map((e) => {
    const status = e.status ?? "status unknown";
    const exp = e.expirationDate ? `, expires ${e.expirationDate}` : "";
    const loc = [e.city, e.state].filter(Boolean).join(", ");
    return `- ${e.legalName} (UEI ${e.uei})${loc ? ` — ${loc}` : ""}: registration ${status}${exp}`;
  });
  return (
    `SAM.gov registration for "${query}":\n` +
    lines.join("\n") +
    "\n\nSAM registration is an eligibility PRECONDITION, not a sign of competitiveness. An Expired/Submitted status means the org must renew before it can receive an award — flag it if a deadline is near."
  );
}

// ── Executor ─────────────────────────────────────────────────────────────────────────────────────
export async function executeDataTool(
  toolUse: { name: string; input: unknown },
  opts: { deps?: DataToolDeps; now?: () => string } = {},
): Promise<{ resultText: string; audit: DataLookupAuditRecord }> {
  const deps = opts.deps ?? defaultDeps;
  const now = opts.now ?? (() => new Date().toISOString());
  const at = now();
  const input = (toolUse.input ?? {}) as Record<string, unknown>;

  if (toolUse.name === PROGRAM_AWARDS_TOOL_NAME) {
    const cfdas = normalizeCfdas(input.cfda);
    const state = typeof input.state === "string" && input.state.trim() ? input.state.trim() : undefined;
    const query = `${cfdas.join(",")}${state ? `@${state}` : ""}`;
    if (cfdas.length === 0) {
      return {
        resultText: "No CFDA / Assistance Listing number was provided. Ask the staffer for the program's CFDA (e.g. \"20.284\") rather than guessing one.",
        audit: { tool: toolUse.name, query, ok: false, reason: "bad_input", at },
      };
    }
    try {
      // throwOnError:true so a USASpending outage/timeout THROWS (→ the catch below, a "could not
      // run" fact) instead of returning [] and being reported as an authoritative "no winners found"
      // gap — the client-facing honesty rule. Without it findProgramAwardees swallows every failure
      // to [] and this catch is dead code (Vercel Agent Review, #552).
      const awardees = await deps.findProgramAwardees(cfdas, { ...(state ? { state } : {}), throwOnError: true });
      return {
        resultText: formatProgramAwards(cfdas, state, awardees),
        audit: { tool: toolUse.name, query, ok: awardees.length > 0, count: awardees.length, reason: awardees.length === 0 ? "no_data" : undefined, at },
      };
    } catch (err) {
      return {
        resultText: `The USASpending program lookup for CFDA ${cfdas.join(", ")} could not run (${err instanceof Error ? err.message : "unknown error"}). Report this as a gap; do not infer who wins.`,
        audit: { tool: toolUse.name, query, ok: false, reason: "upstream", at },
      };
    }
  }

  if (toolUse.name === ORG_HISTORY_TOOL_NAME) {
    const orgName = typeof input.org_name === "string" ? input.org_name.trim() : "";
    if (!orgName) {
      return {
        resultText: "No organization name was provided for the federal-history lookup. Ask the staffer for the org name.",
        audit: { tool: toolUse.name, query: "", ok: false, reason: "bad_input", at },
      };
    }
    const result = await deps.checkPastPerformance(orgName);
    return {
      resultText: formatOrgHistory(result),
      audit: { tool: toolUse.name, query: orgName, ok: result.verified, count: result.award_count, reason: result.verified ? undefined : "upstream", at },
    };
  }

  if (toolUse.name === SAM_ENTITY_TOOL_NAME) {
    const uei = typeof input.uei === "string" ? input.uei.trim() : "";
    const orgName = typeof input.org_name === "string" ? input.org_name.trim() : "";
    const state = typeof input.state === "string" && input.state.trim() ? input.state.trim() : undefined;
    if (!uei && !orgName) {
      return {
        resultText: "No org name or UEI was provided for the SAM lookup. Ask the staffer for the organization name (and state) or its UEI.",
        audit: { tool: toolUse.name, query: "", ok: false, reason: "bad_input", at },
      };
    }
    const query = uei || `${orgName}${state ? ` (${state})` : ""}`;
    try {
      let entities: SamEntity[];
      if (uei && isValidUei(uei)) {
        const one = await deps.lookupByUei(uei);
        entities = one ? [one] : [];
      } else if (uei) {
        // A UEI-shaped-but-invalid value: don't spend a name search on it, say so.
        return {
          resultText: `"${uei}" is not a valid UEI (a UEI is 12 characters, excluding I and O). Provide a valid UEI or an org name.`,
          audit: { tool: toolUse.name, query, ok: false, reason: "bad_input", at },
        };
      } else {
        entities = await deps.searchByNameState(orgName, state ?? null, null);
      }
      return {
        resultText: formatSamEntity(query, entities),
        audit: { tool: toolUse.name, query, ok: entities.length > 0, count: entities.length, reason: entities.length === 0 ? "no_data" : undefined, at },
      };
    } catch (err) {
      const reason = err instanceof SamError ? err.code : "upstream";
      const detail = err instanceof Error ? err.message : "unknown error";
      const note =
        reason === "config"
          ? "The SAM.gov lookup is not configured in this environment — report registration as unverified, do not assume it."
          : `The SAM.gov lookup could not run (${detail}) — report registration as unverified, do not assume it.`;
      return { resultText: note, audit: { tool: toolUse.name, query, ok: false, reason, at } };
    }
  }

  return {
    resultText: `Unknown data tool "${toolUse.name}". Nothing was looked up.`,
    audit: { tool: toolUse.name, query: "", ok: false, reason: "bad_input", at },
  };
}
