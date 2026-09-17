// GrantBot's STORED-NOFO grounding + tool. The platform already fetches and shreds each grant's NOFO at
// ingest and keeps the parsed text in `grants.raw_text` (up to 100k chars) plus quote-verified structured
// fields (description_brief, allowable_uses, application_requirements) and the eligibility hard gates.
// GrantBot was NOT reading any of that — its grant anchor carried only title/funder/CFDA/deadline — so it
// live-RE-fetched and RE-parsed the same NOFO PDF the platform had already parsed, and that uncancellable
// pdf-parse is what hung a turn for minutes (see fetch.ts + tool-loop.ts). This module closes the gap two
// ways, both behind ONE flag (GRANTBOT_STORED_NOFO_ENABLED, default OFF):
//
//   LAYER 1 — grounding injection. When a conversation is anchored to a grant, a cacheable:false block
//   carries the grant's stored STRUCTURED fields (what it funds, who's eligible, allowable/not-allowed
//   uses, application requirements, the ask) into the turn. Most "is the deadline realistic / who's
//   eligible / what can it fund" asks are answered with ZERO tool rounds — the content is just there.
//
//   LAYER 2 — read_stored_nofo, a read-only tool. Returns a bounded window of the stored raw_text (plus
//   the structured fields) FROM THE GRANT ROW: a Postgres text read, no PDF, no network, no parse, so it
//   CANNOT hang. It REPLACES fetch_grant_source for any ingested grant; live-fetch stays only as the
//   fallback for a grant the platform does not have (raw_text null / not ingested).
//
// SCOPE / SAFETY, mirroring the other GrantBot tools:
//   · The grant corpus is NOT client-private (the focus-grant.ts note), so reading any grant's stored
//     NOFO leaks nothing across clients — a forged opportunity number only mis-targets the read.
//   · read_stored_nofo only SELECTs our own Postgres; no write, no external egress, no internal reach
//     beyond the grants table. It is the LEAST risky GrantBot tool.
//   · The raw_text rides the SAME untrusted PASTED-CONTENT frame as a fetched page (it is the NOFO
//     author's text the platform ingested), so a directive inside it stays quoted material.
//   · OFF is byte-identical: no Layer-1 block, no tool, no instruction block (see turn.ts / firm-turn.ts).
//
// PURE-TESTABLE. loadStoredNofoRow takes the db as a param (no server-only import), and the formatter +
// block builder + executor are pure over an injected row/clock — so the formatting, the fail-open
// resolution, and the flag are unit-tested without a live model, a network, or a database.

import type { SupabaseClient } from "@supabase/supabase-js";
import { framePastedContent, type PromptBlock } from "@/lib/grantbot/prompt";
import { truncateSafely } from "@/lib/grantbot/label";
import { readAllowableUses } from "@/lib/grants/allowable-uses";
import { readApplicationRequirements } from "@/lib/grants/requirements";

// Off unless exactly "true" — same shape as grantbotWebFetchEnabled()/grantbotDataToolsEnabled(). Read
// SERVER-SIDE (never NEXT_PUBLIC_), so flipping it is a config change a redeploy binds; default-off is the
// instant-revert guarantee. ONE flag gates BOTH layers on BOTH surfaces (per-client + firm).
export function grantbotStoredNofoEnabled(): boolean {
  return process.env.GRANTBOT_STORED_NOFO_ENABLED === "true";
}

// The stored raw_text window handed to the model, mirroring web-fetch's MAX_FETCH_TEXT_CHARS so a stored
// NOFO and a fetched page cost the model's context window the same (~15k tokens). raw_text is capped at
// 100k chars at ingest, so a long NOFO returns its first 60k with a truncation note; the structured
// fields (already distilled from the whole thing) cover the rest.
export const MAX_STORED_NOFO_CHARS = 60_000;

export const READ_STORED_NOFO_TOOL_NAME = "read_stored_nofo";

// ── The stored grant row ─────────────────────────────────────────────────────────────────────────
// The structured fields Layer 1 injects + Layer 2 returns. raw_text is loaded ONLY for the tool (Layer
// 2), never for the Layer-1 block, because it is the largest column on the table.
export interface StoredNofoRow {
  id: string;
  title: string;
  funder: string | null;
  cfda: string | null;
  fon: string | null;
  deadline: string | null;
  shredDepth: "full" | "summary" | null;
  descriptionBrief: string | null;
  eligibleEntityTypes: string[] | null;
  geographicEligibility: string | null;
  ineligibleEntities: string | null;
  subawardProhibited: boolean | null;
  costShare: string | null;
  awardRangeMin: string | null;
  awardRangeMax: string | null;
  awardRangeIsEstimate: boolean | null;
  numAwards: string | null;
  allowableUses: unknown; // parsed via readAllowableUses at format time
  applicationRequirements: unknown; // parsed via readApplicationRequirements at format time
  rawText: string | null; // present only when loaded with { withRawText: true }
}

// The columns that carry the structured detail. raw_text is appended only for the tool path.
const STRUCTURED_COLUMNS =
  "id, title, funder, fon, assistance_listings, submission_deadline, shred_depth, description_brief, " +
  "eligible_entity_types, geographic_eligibility, ineligible_entities, subaward_prohibited, cost_share, " +
  "award_range_min, award_range_max, award_range_is_estimate, num_awards, allowable_uses, application_requirements";

interface RawGrantRow {
  id: string;
  title: string | null;
  funder: string | null;
  fon: string | null;
  assistance_listings: { number?: string | null }[] | null;
  submission_deadline: string | null;
  shred_depth: "full" | "summary" | null;
  description_brief: string | null;
  eligible_entity_types: string[] | null;
  geographic_eligibility: string | null;
  ineligible_entities: string | null;
  subaward_prohibited: boolean | null;
  cost_share: string | null;
  award_range_min: string | null;
  award_range_max: string | null;
  award_range_is_estimate: boolean | null;
  num_awards: string | null;
  allowable_uses: unknown;
  application_requirements: unknown;
  raw_text?: string | null;
}

function cfdaOf(listings: { number?: string | null }[] | null): string | null {
  return Array.isArray(listings)
    ? listings.map((a) => a?.number).filter(Boolean).join(", ") || null
    : null;
}

function mapRow(g: RawGrantRow): StoredNofoRow {
  return {
    id: String(g.id),
    title: (g.title ?? "").trim() || "this grant",
    funder: g.funder?.trim() || null,
    cfda: cfdaOf(g.assistance_listings),
    fon: g.fon?.trim() || null,
    deadline: g.submission_deadline?.trim() || null,
    shredDepth: g.shred_depth ?? null,
    descriptionBrief: g.description_brief?.trim() || null,
    eligibleEntityTypes: Array.isArray(g.eligible_entity_types) ? g.eligible_entity_types : null,
    geographicEligibility: g.geographic_eligibility?.trim() || null,
    ineligibleEntities: g.ineligible_entities?.trim() || null,
    subawardProhibited: typeof g.subaward_prohibited === "boolean" ? g.subaward_prohibited : null,
    costShare: g.cost_share?.trim() || null,
    awardRangeMin: g.award_range_min?.trim() || null,
    awardRangeMax: g.award_range_max?.trim() || null,
    awardRangeIsEstimate: typeof g.award_range_is_estimate === "boolean" ? g.award_range_is_estimate : null,
    numAwards: g.num_awards?.trim() || null,
    allowableUses: g.allowable_uses ?? null,
    applicationRequirements: g.application_requirements ?? null,
    rawText: typeof g.raw_text === "string" ? g.raw_text : null,
  };
}

// Load one grant's stored NOFO, by internal id OR by opportunity number (FON). raw_text is included
// ONLY when withRawText is set (the tool path); Layer-1 grounding omits it to avoid pulling the largest
// column for a few lines. FAIL-SOFT: any error (incl. a query fault) returns null → the caller degrades
// (Layer 1 adds no block; the tool reports "not found" and the model falls back to fetch), never a crash.
export async function loadStoredNofoRow(
  db: SupabaseClient,
  selector: { grantId?: string | null; fon?: string | null },
  opts: { withRawText?: boolean } = {},
): Promise<StoredNofoRow | null> {
  const columns = opts.withRawText ? `${STRUCTURED_COLUMNS}, raw_text` : STRUCTURED_COLUMNS;
  try {
    if (selector.grantId) {
      const { data } = await db.from("grants").select(columns).eq("id", selector.grantId).maybeSingle();
      return data ? mapRow(data as unknown as RawGrantRow) : null;
    }
    const fon = selector.fon?.trim();
    if (fon) {
      // Match the FON LITERALLY, not as a LIKE pattern. `.ilike` treats its value as a pattern, so an
      // unescaped `_` (any single char) or `%` (any run) in the model-supplied opportunity number would
      // wildcard-match a SIBLING grant, and limit(1) would return it — the tool then presents that wrong
      // grant's NOFO as "the platform's OWN parsed copy" for the requested FON (Claude Code Review). FONs
      // commonly contain `_`, so this is real. Escape the metacharacters exactly like sent-status.ts, and
      // BACKSTOP with a JS case-insensitive exact-match so a sibling row is never mistaken for the ask
      // (ilike stays for case-insensitivity; a staffer may type a FON in lower case). limit(1) + [0]
      // rather than maybeSingle so a rare duplicate FON returns one row instead of throwing.
      const escaped = fon.replace(/[%_\\]/g, (m) => `\\${m}`);
      const { data } = await db.from("grants").select(columns).ilike("fon", escaped).limit(1);
      const row = Array.isArray(data) ? data[0] : null;
      if (!row) return null;
      const mapped = mapRow(row as unknown as RawGrantRow);
      return (mapped.fon ?? "").toLowerCase() === fon.toLowerCase() ? mapped : null;
    }
    return null;
  } catch (err) {
    console.error("GrantBot stored-NOFO read failed", err);
    return null;
  }
}

// Layer-1 loader: the structured fields for the anchored grant, no raw_text. Returns null when the grant
// carries nothing beyond what the focus block already shows (a husk / summary with no detail), so the
// Layer-1 block is simply absent for such a grant — byte-identical to the focus block alone.
export async function loadGrantNofoFields(db: SupabaseClient, grantId: string): Promise<StoredNofoRow | null> {
  const row = await loadStoredNofoRow(db, { grantId }, { withRawText: false });
  if (!row) return null;
  // Only a FULL shred is real parsed-NOFO detail. On a SUMMARY shred the platform never parsed the NOFO:
  // pipeline.ts sets raw_text = the Simpler API JSON and only overwrites it with the real NOFO text on a
  // successful full shred, so a summary grant's fields come from the API summary. Layer 1 rides a full
  // shred only, so its "already parsed this grant's NOFO / do NOT fetch" framing is never a false claim
  // and the model can still fetch the real NOFO for a summary grant (Codex #586).
  if (row.shredDepth !== "full") return null;
  return hasStructuredDetail(row) ? row : null;
}

function hasStructuredDetail(row: StoredNofoRow): boolean {
  const { allowed, notAllowed } = readAllowable(row.allowableUses);
  return Boolean(
    row.descriptionBrief ||
      (row.eligibleEntityTypes && row.eligibleEntityTypes.length) ||
      row.geographicEligibility ||
      row.ineligibleEntities ||
      row.awardRangeMin ||
      row.awardRangeMax ||
      row.numAwards ||
      row.costShare ||
      allowed.length ||
      notAllowed.length ||
      requirementLines(row.applicationRequirements).length,
  );
}

// ── Pure formatting (shared by Layer 1's block and Layer 2's tool result) ─────────────────────────
function readAllowable(raw: unknown): { allowed: string[]; notAllowed: string[] } {
  const parsed = readAllowableUses(raw);
  const allowed: string[] = [];
  const notAllowed: string[] = [];
  if (parsed) {
    for (const it of parsed.items) {
      if (it.kind === "not_allowed") notAllowed.push(it.line);
      else allowed.push(it.line);
    }
  }
  return { allowed, notAllowed };
}

function requirementLines(raw: unknown): string[] {
  const parsed = readApplicationRequirements(raw);
  if (!parsed) return [];
  return [
    ...parsed.required_sections,
    ...parsed.page_format_limits,
    ...parsed.required_attachments,
    ...parsed.evaluation_criteria,
    ...parsed.other_notes,
  ].map((i) => i.text);
}

function bulletList(items: string[]): string {
  return items.map((i) => `  • ${i}`).join("\n");
}

// Render the structured fields as prompt text. Pure. Each field appears ONLY when present, so a
// thinly-shredded grant renders a short honest note rather than empty headings. Used verbatim by both
// the Layer-1 grounding block and the Layer-2 tool result, so the two can never drift.
export function formatNofoFields(row: StoredNofoRow): string {
  const parts: string[] = [];
  if (row.descriptionBrief) parts.push(`What it funds: ${row.descriptionBrief}`);

  const eligibility: string[] = [];
  if (row.eligibleEntityTypes && row.eligibleEntityTypes.length) {
    eligibility.push(`Eligible entity types: ${row.eligibleEntityTypes.join(", ")}`);
  }
  if (row.geographicEligibility) eligibility.push(`Geographic eligibility: ${row.geographicEligibility}`);
  if (row.ineligibleEntities) eligibility.push(`Ineligible: ${row.ineligibleEntities}`);
  if (row.subawardProhibited === true) eligibility.push("Subawards are prohibited (prime-only).");
  if (eligibility.length) parts.push(eligibility.join("\n"));

  const ask: string[] = [];
  const award = formatAward(row);
  if (award) ask.push(`Award range: ${award}`);
  if (row.numAwards) ask.push(`Expected awards: ${row.numAwards}`);
  if (row.costShare) ask.push(`Cost share / match: ${row.costShare}`);
  if (ask.length) parts.push(ask.join("\n"));

  const { allowed, notAllowed } = readAllowable(row.allowableUses);
  if (allowed.length) parts.push(`Allowable uses of funds (quote-verified from the NOFO):\n${bulletList(allowed)}`);
  if (notAllowed.length) parts.push(`NOT allowed / restricted (quote-verified from the NOFO):\n${bulletList(notAllowed)}`);

  const reqs = requirementLines(row.applicationRequirements);
  if (reqs.length) parts.push(`Application requirements (quote-verified from the NOFO):\n${bulletList(reqs)}`);

  return parts.join("\n\n");
}

function formatAward(row: StoredNofoRow): string | null {
  const min = row.awardRangeMin;
  const max = row.awardRangeMax;
  if (!min && !max) return null;
  const est = row.awardRangeIsEstimate ? " (estimate)" : "";
  if (min && max) return min === max ? `${min}${est}` : `${min}–${max}${est}`;
  return `${min || max}${est}`;
}

// ── Layer 1: the grounding block ──────────────────────────────────────────────────────────────────
// cacheable:false and appended AFTER the cache breakpoint (like every per-turn block), present ONLY for
// an anchored thread with structured detail on file. Reuses the "focus-grant" block kind (it IS grant
// grounding); its distinct `source` tells it apart from the anchor block in the manifest.
export function buildStoredNofoFieldsBlock(row: StoredNofoRow): PromptBlock {
  return {
    kind: "focus-grant",
    source: "lib/grantbot/stored-nofo.ts",
    version: "2026-09-17.1",
    cacheable: false,
    text: [
      "PLATFORM'S STORED DETAIL FOR THIS GRANT",
      "The platform already ingested and parsed this grant's NOFO. Its stored, quote-verified details are below — use them to answer directly, and do NOT fetch the live source for facts already here:",
      "",
      formatNofoFields(row),
      "",
      `If you need MORE than these fields (specific NOFO language the summary omits), call ${READ_STORED_NOFO_TOOL_NAME} to read the platform's stored full NOFO text for this grant — that is the parsed copy, so you never need to re-fetch the PDF. Keep prime vs. partner/sub eligibility distinct and label award figures as estimates.`,
    ].join("\n"),
  };
}

// ── Layer 2: the tool ─────────────────────────────────────────────────────────────────────────────
export const READ_STORED_NOFO_TOOL = {
  name: READ_STORED_NOFO_TOOL_NAME,
  description:
    "Read the platform's OWN already-parsed copy of a grant's NOFO — the text and structured details it extracted at ingest — instead of fetching and re-parsing the live source. Returns what the grant funds, who is eligible, allowable/not-allowed uses of funds, application requirements, and the stored NOFO text. Prefer this over fetch_grant_source for any grant the platform has: it is an instant database read (no PDF download, no parse). For the grant this conversation is about, call it with no arguments; for any other grant, pass its opportunity number. Read-only.",
  input_schema: {
    type: "object" as const,
    properties: {
      opportunity_number: {
        type: "string",
        description:
          "The grant's opportunity number / FON (e.g. \"USDA-NRCS-NHQ-FSCP-26-NOFO0001453\"), if you are asking about a grant OTHER than the one this thread is anchored to. Omit to read the anchored grant.",
      },
    },
  },
} as const;

export interface NofoReadAuditRecord {
  tool: string;
  query: string; // the FON or "anchored:<grantId>" that resolved the read
  ok: boolean; // a grant was found in the platform
  hasRawText: boolean; // the found grant carried stored full text
  reason?: string; // present when !ok (not_found / no_grant_specified)
  at: string;
}

// Execute read_stored_nofo. Resolves the grant from the model's opportunity_number, else the anchored
// grant (focusGrantId, server-side — never the request body). Returns the structured fields + a bounded
// window of the stored raw_text, framed as untrusted evidence. FAIL-OPEN toward fetch: a grant not in
// the platform, or one with no stored text, is a typed result that tells the model to fetch the official
// source instead — never a guess.
export async function executeStoredNofo(
  toolUse: { input: unknown },
  ctx: { db: SupabaseClient; focusGrantId?: string | null; now?: () => string },
): Promise<{ resultText: string; audit: NofoReadAuditRecord }> {
  const now = ctx.now ?? (() => new Date().toISOString());
  const at = now();
  const input = (toolUse.input ?? {}) as Record<string, unknown>;
  const opp = typeof input.opportunity_number === "string" ? input.opportunity_number.trim() : "";

  if (!opp && !ctx.focusGrantId) {
    return {
      resultText:
        "No grant was specified and this conversation is not anchored to a specific grant. Provide the grant's opportunity number (FON), or ask the staffer which grant they mean — do not guess a NOFO.",
      audit: { tool: READ_STORED_NOFO_TOOL_NAME, query: "", ok: false, hasRawText: false, reason: "no_grant_specified", at },
    };
  }

  const selector = opp ? { fon: opp } : { grantId: ctx.focusGrantId };
  const query = opp ? opp : `anchored:${ctx.focusGrantId}`;
  const row = await loadStoredNofoRow(ctx.db, selector, { withRawText: true });

  if (!row) {
    return {
      resultText:
        `No grant matching ${opp ? `opportunity number "${opp}"` : "this conversation's anchor"} is in the platform. ` +
        "If you have the official .gov source URL, fetch that instead; otherwise tell the staffer the platform has no record of it — do NOT reconstruct the NOFO from memory.",
      audit: { tool: READ_STORED_NOFO_TOOL_NAME, query, ok: false, hasRawText: false, reason: "not_found", at },
    };
  }

  const header = `STORED NOFO — ${row.title}${headerFacts(row)}`;
  const fields = formatNofoFields(row);
  const fieldsSection = fields ? `\n\nStored, quote-verified details:\n${fields}` : "";
  // A SUMMARY shred's raw_text is the Simpler API JSON, NOT parsed NOFO text (pipeline.ts sets raw_text =
  // rawJson and only overwrites it with nofo.text on a successful full shred). Treat stored text as the
  // real NOFO ONLY on a full shred — otherwise a summary grant's API JSON would be handed to the model as
  // "the full NOFO" with a "do NOT fetch" instruction, the exact mislabel this tool exists to prevent
  // (Codex #586). A summary grant falls through to the no-full-text fallback, which routes it to fetching.
  const raw = row.shredDepth === "full" ? (row.rawText ?? "").trim() : "";

  if (!raw) {
    return {
      resultText:
        `${header}\nThis is the platform's stored record for this grant, but it has NO parsed full NOFO text on file` +
        `${row.shredDepth === "summary" ? " (it was ingested from an API summary, not a full NOFO shred)" : ""}.` +
        `${fieldsSection}\n\n` +
        "For the full NOFO language beyond the fields above, fetch the official .gov source if you have the URL — the platform has no stored full text for this grant. Do NOT infer NOFO language that is not shown here.",
      audit: { tool: READ_STORED_NOFO_TOOL_NAME, query, ok: true, hasRawText: false, at },
    };
  }

  const { text: window, truncated } = truncateSafely(raw, MAX_STORED_NOFO_CHARS);
  const truncatedNote = truncated
    ? "\n\n[The stored NOFO text was longer than the window and was truncated — treat it as partial; the structured details above are distilled from the whole document.]"
    : "";
  const framed = framePastedContent(
    window,
    at,
    `platform's stored NOFO text for ${row.fon || row.title}, parsed at ingest`,
  );

  return {
    resultText: `${header}\nThis is the platform's OWN parsed copy — you do NOT need to fetch the live source for this grant.${fieldsSection}\n\nStored full NOFO text:\n${framed}${truncatedNote}`,
    audit: { tool: READ_STORED_NOFO_TOOL_NAME, query, ok: true, hasRawText: true, at },
  };
}

function headerFacts(row: StoredNofoRow): string {
  const facts = [row.funder, row.cfda ? `CFDA ${row.cfda}` : null, row.fon ? `opportunity ${row.fon}` : null]
    .filter(Boolean)
    .join(" · ");
  return facts ? ` (${facts})` : "";
}

// ── The flag-gated instruction block ──────────────────────────────────────────────────────────────
// Appended AFTER the cache breakpoint (cacheable:false) and ONLY when the flag is on, so the flag-off
// prompt is unchanged and existing caches are not busted. Carries the "prefer stored over fetch" rule
// AND the false-success rule (mirroring data-tools' "never claim data you did not fetch/read this turn").
export const STORED_NOFO_INSTRUCTION_BLOCK: PromptBlock = {
  kind: "web-fetch",
  source: "lib/grantbot/stored-nofo.ts",
  version: "2026-09-17.1",
  cacheable: false,
  text: [
    "STORED NOFO — READ THE PLATFORM'S OWN COPY, DON'T RE-FETCH",
    `The platform already fetches and parses each grant's NOFO at ingest and keeps the text and structured details. You have a read-only tool, ${READ_STORED_NOFO_TOOL_NAME}, that returns that stored copy directly from the database — no download, no PDF parse, instant. It only READS our own grant record: it cannot write, act, or reach anything else.`,
    "",
    `PREFER IT OVER FETCHING. For any grant the platform has, call ${READ_STORED_NOFO_TOOL_NAME} FIRST rather than fetch_grant_source — you would only be re-fetching and re-parsing a NOFO we already parsed. For the grant this thread is about, call it with no arguments; for another grant, pass its opportunity number (FON). Only fall back to fetching the live .gov source when ${READ_STORED_NOFO_TOOL_NAME} reports the platform has no stored copy (a grant we have not ingested), and only if you have the official URL.`,
    "",
    `NEVER CLAIM A SOURCE YOU DID NOT READ THIS TURN. Do not write "I have the full NOFO", "I read the NOFO", "I pulled the source", or name a deadline / eligibility rule / award figure AS IF from the NOFO unless a ${READ_STORED_NOFO_TOOL_NAME} or fetch_grant_source tool_result IN THIS TURN actually returned it. Claiming to have read a source you did not read is a fabrication — the exact failure this rule exists to stop. If a read returns nothing usable, that is a gap to report (name what you could not read and which official source to check), never one to fill from memory.`,
    "",
    "Keep the tool itself OUT of your reply — no 'let me pull the NOFO', no tool names, no play-by-play. The staffer sees only your finished answer, or the plain could-not-find line. Read the stored copy only when it genuinely helps answer the question.",
  ].join("\n"),
};
