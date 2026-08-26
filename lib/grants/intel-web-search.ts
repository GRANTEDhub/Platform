// IntellEngine QA — the web-SEARCH discovery capability (INTEL_WEB_SEARCH_ENABLED). The QA pass has
// always been able to FETCH a .gov URL it is handed (fetchGrantSource) and follow .gov links inside a
// fetched page; what it could NOT do is DISCOVER the authoritative page when the NOFO doesn't link it and
// the seed map (allocation-sources.ts) has no entry. This adds that discovery — Anthropic's server-side
// web_search tool — behind a flag, so an unseeded formula program's allocation table can be found.
//
// WHY SERVER-SIDE web_search, AND WHY IT DOES NOT WIDEN THE SAFETY BOUNDARY:
//   - It runs on Anthropic's servers, so it adds NO new egress from our infra, NO SSRF surface, and NO
//     new secret. (Contrast a custom search-API tool, which would need all three.)
//   - It is DISCOVERY ONLY. The verification boundary is unchanged and structural: an adverse verdict
//     still requires a verbatim quote that appears in a page we actually FETCHED with fetchGrantSource
//     (quoteGroundedInBodies, the fail-safe in intel-review.ts) — and fetchGrantSource only reaches the
//     .gov allowlist. A web_search RESULT (a snippet from anywhere) never enters fetchedBodies, so it can
//     never ground a demote/flag. The most a bad/injected snippet can do is send the model to fetch a
//     .gov page (allowlist-guarded) or leave the verdict "unverified". QA writes no score regardless
//     (proposal-only), so the blast radius is near zero.
//   - It is FLAG-GATED and OFF is byte-identical to today's fetch-only pass: with the flag off, no
//     web_search tool is attached to the request and no search instruction is added to the system prompt,
//     so the QA request body, the tool set, and the stored verdict are exactly the pre-search ones. The
//     flag is the revert. (Vercel binds env at deploy, so flipping it is a config change + redeploy.)
//
// SCOPED TO THE QA PASS. GrantBot chat (turn.ts) is untouched — this tool is assembled only in
// intel-review.ts's realCallModel. Its default-off keeps that path exactly as it is until the live eval
// (RUN_INTEL_EVAL, INTEL_WEB_SEARCH_ENABLED) proves discovery surfaces the miss without over-demoting a
// genuine direct recipient.

// Off unless exactly "true" — same shape as grantbotWebFetchEnabled(). Read SERVER-SIDE (never
// NEXT_PUBLIC_). Default OFF is the byte-identical-to-today guarantee and the instant revert.
export function intelWebSearchEnabled(): boolean {
  return process.env.INTEL_WEB_SEARCH_ENABLED === "true";
}

// The web_search tool TYPE. This SDK (@anthropic-ai/sdk 0.39.0) predates server-side web search and
// ships no type for it, so the tool is passed as a cast literal (the wire protocol carries it; the SDK
// only serializes). We default to the GA, non-beta variant, which is the one most likely accepted on the
// standard /v1/messages endpoint without a beta header. If the live eval returns a 400 naming the tool
// type (e.g. the model wants the newer dynamic-filtering variant "web_search_20260209", or a beta
// header), the fix is this one constant (and, if required, a per-request anthropic-beta header on the
// create call in intel-review.ts) — a localized change, not a rebuild. The eval is the arbiter: nothing
// ships to prod until the flag is flipped, and the flag is only flipped on a green eval.
export const WEB_SEARCH_TOOL_TYPE = "web_search_20250305";

// Bound the number of searches per QA pass (the discovery analogue of MAX_INTEL_FETCH_ROUNDS bounding
// fetches). A verification pass needs a search or two to find the right table, not a crawl.
export const MAX_INTEL_SEARCHES = 4;

export const WEB_SEARCH_TOOL_NAME = "web_search";

// The server-tool definition, as a server-side constant (never from the request body — same rule as
// WEB_FETCH_TOOL and turnBlocks). No `run` function: server tools execute on Anthropic's servers.
export const WEB_SEARCH_TOOL = {
  type: WEB_SEARCH_TOOL_TYPE,
  name: WEB_SEARCH_TOOL_NAME,
  max_uses: MAX_INTEL_SEARCHES,
} as const;

// The phase-1 tool set + system prompt for a QA call, assembled from the base fetch tool + base system.
// PURE and exported so the flag-gated shape is unit-tested structurally, not just by comment:
//   discovery=false → tools are EXACTLY [fetchTool] and system is baseSystem unchanged — byte-identical
//     to the pre-search pass (this is the revert guarantee, proven by a test, not asserted in prose);
//   discovery=true  → the fetch tool PLUS Anthropic's server-side web_search, and the search addendum.
// The base fetch tool + base system are passed in (rather than imported) to avoid a cycle with
// intel-review.ts, which owns them.
export function intelPhase1Config<T>(
  discovery: boolean,
  fetchTool: T,
  baseSystem: string,
): { tools: Array<T | typeof WEB_SEARCH_TOOL>; system: string } {
  return {
    tools: discovery ? [fetchTool, WEB_SEARCH_TOOL] : [fetchTool],
    system: discovery ? baseSystem + SEARCH_SYSTEM_ADDENDUM : baseSystem,
  };
}

// The flag-gated system-prompt addendum. Appended to INTEL_SYSTEM_PROMPT only when the flag is on, so the
// flag-off system prompt is unchanged. It states the discovery-only contract in the prompt too, though the
// real guarantee is structural (quoteGroundedInBodies), so a prompt drift can't loosen the fail-safe.
export const SEARCH_SYSTEM_ADDENDUM = `
ADDITIONAL TOOL — web_search:
You also have web_search, a read-only web search, to DISCOVER the authoritative page when you are not handed its URL — e.g. the allocation / sub-recipient table for a formula program that the sources above do not list. Use it to FIND the right official source, then read it for real.

Rules that make search safe and useful:
- A search RESULT (a title or snippet) is a LEAD, never authority and never evidence. It is NOT sufficient to ground any verdict.
- After a search points you to the authoritative page, FETCH that page with fetch_grant_source and verify against what you actually read. Only a verbatim quote from a page you FETCHED can ground a demote or flag.
- Prefer official U.S. .gov sources (the program's agency page, the allocation table, the State Administering Agency). Ignore secondary, commentary, or commercial sites — they cannot be fetched and cannot ground anything.
- If search finds no authoritative source you can then fetch, say so and return "unverified". Do not reconstruct an allocation reality from a snippet.`;
