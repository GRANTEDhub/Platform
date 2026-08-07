import type { SupabaseClient } from "@supabase/supabase-js";
import { getAnthropicClient, MODEL } from "@/lib/anthropic";

// WHAT THE MONEY MAY BE SPENT ON, per grant, with every line anchored to a verbatim span of
// the NOFO (migration 0072).
//
// Sibling to description_brief (lib/grants/brief.ts): grant-level not client-level,
// enrichment only, filled by a bounded hourly sweep rather than in the ingest path
// (app/api/cron/ingest/route.ts and lib/grants/pipeline.ts are protected files). Nothing in
// the occupancy/seat scorer reads this column, so a list -- good, bad, or absent -- cannot
// move a fit score.
//
// WHY THIS ONE CARRIES QUOTES AND THE BRIEF DOES NOT. A brief is a paraphrase; a reader
// treats it as our summary. An allowable-uses list reads as a statement of fact about what
// a funder will pay for, and a client makes budget decisions on it. A line that is merely
// plausible is worse than no line, because it looks like it came from the NOFO. So every
// line ships with the span it came from and is DROPPED unless that span is actually present
// in raw_text. The list is short and verified rather than long and asserted.
//
// NOT CLIENT-VISIBLE YET. Rendering is gated behind ALLOWABLE_USES_CLIENT_VISIBLE (default
// off) for a staff-only first week while the real drop rate is observed. The column fills
// regardless -- the gate is presentation, not generation.

// Hard ceiling on list length. A NOFO's allowable-costs section can run pages; a client
// reading a grant card needs the shape of it, not a transcription. Anything past this is
// dropped before verification, so the cap costs nothing at the API.
const MAX_ITEMS = 12;
// A line is a budget category, not a sentence of narrative.
const MAX_LINE_WORDS = 25;
// Long enough to carry a real clause, short enough that "the quote" cannot become "the
// section". A model that wants to quote 2000 characters is not anchoring a line, it is
// pasting -- and a huge span is also likelier to straddle a page break and fail the match
// for reasons that have nothing to do with faithfulness.
const MAX_QUOTE_CHARS = 300;
// Below this a quote stops being evidence: a handful of characters will match somewhere in
// any long document by accident, which would make the gate look like it was passing when it
// was only finding "and".
const MIN_QUOTE_CHARS = 24;

// How much NOFO text to hand the model, centred on the allowable-costs section rather than
// taken from the top -- see allowableSource.
const WINDOW_CHARS = 14000;
// Fallback window when no heading matches, taken from the head like the brief's excerpt.
const HEAD_CHARS = 10000;

// The headings a federal NOFO actually uses for this section. Deliberately broad and
// deliberately including the NEGATIVE forms ("unallowable", "funding restrictions"): those
// sections sit adjacent to the allowable list far more often than not, so anchoring on them
// still lands the window in the right place.
const SECTION_PATTERNS = [
  /allowable\s+(?:costs?|uses?|activities|expenses?)/i,
  /unallowable\s+(?:costs?|uses?|activities|expenses?)/i,
  /funding\s+restrictions?/i,
  /use\s+of\s+(?:grant\s+)?funds?/i,
  /eligible\s+(?:costs?|uses?|activities|expenses?)/i,
  /cost\s+principles?/i,
];

// THE SENTINEL, and it is deliberately not an empty render. A blank section reads as "we
// have not looked"; this says what is true -- the NOFO did not tell us plainly, and a human
// should be asked. Kept here rather than at the render site so both surfaces cannot drift.
export const ALLOWABLE_USES_FALLBACK = "Not clearly specified in the NOFO — Ask our team";

// Why a list came back empty. Stored (not just logged) because items: [] cannot distinguish
// these three, and they are three different problems: the NOFO's, the model's, and ours.
export type AllowableUsesReason = "no_section" | "no_raw_text" | "all_dropped";

export interface AllowableUseItem {
  // The rendered line -- a budget category in plain language.
  line: string;
  // The verbatim NOFO span this line came from. Present in raw_text under normalization, or
  // the item is not here at all.
  quote: string;
}

export interface AllowableUses {
  items: AllowableUseItem[];
  // Null when items is non-empty. Non-null and items empty when there is nothing to show.
  reason: AllowableUsesReason | null;
}

export interface AllowableUsesGrant {
  id: string;
  title: string | null;
  funder: string | null;
  raw_text?: string | null;
}

const SYSTEM = `You extract ALLOWABLE USES OF FUNDS from U.S. federal and state grant notices for GRANTED, a grant-consulting firm.

You are given an excerpt of a notice of funding opportunity. Your job is to list what the money may be spent on, and to prove every line by quoting the notice.

For each allowable use, return:
- "line": the spending category in plain language, at most ${MAX_LINE_WORDS} words. No hype, no bullets, no headings, no trailing punctuation.
- "quote": a VERBATIM span copied character-for-character from the excerpt that establishes that line. Between ${MIN_QUOTE_CHARS} and ${MAX_QUOTE_CHARS} characters.

Rules, in order of importance:
1. THE QUOTE MUST BE COPIED, NOT RECONSTRUCTED. Do not fix spelling, expand abbreviations, change punctuation, join lines, or tidy spacing. If you cannot copy a span exactly, omit that line entirely. A line without a real quote is worse than a missing line.
2. Every quote must come from the excerpt you were given. Never quote from memory of similar programs.
3. Only ALLOWABLE uses. Do not list what is prohibited, unallowable, or restricted, even though the excerpt may describe those alongside.
4. At most ${MAX_ITEMS} items. Prefer the distinct, substantive categories over exhaustive subdivision.
5. Do not state dollar amounts, caps, percentages, deadlines, or match requirements. Those are rendered separately from verified fields.
6. Do not name any applicant organization or assess anyone's fit. This list is shown to every client matched to the grant.
7. Set has_section to false when the excerpt contains no passage that actually establishes what funds may be spent on. An excerpt that only describes program goals is NOT an allowable-costs section. Returning has_section false is a correct and useful answer -- guessing is not.

Call the tool exactly once.`;

// WHERE TO LOOK, and why not the top of the document.
//
// The brief's excerpt takes the first 8000 characters, which is right for its job -- the
// shape of a program is established in the opening pages. Allowable costs are not: in a
// federal NOFO they sit in Section B or C, routinely 40k+ characters in. Handing the model
// a head excerpt would make it answer has_section=false on notices that DO have a section,
// and the fallback would then read "not clearly specified in the NOFO" when the truth is
// that we never showed it the page. That is the failure mode this function exists to stop.
//
// The model still decides whether a real section is present -- this only decides where it
// gets to look. When no heading matches we fall back to the head rather than skipping the
// call, because a notice can describe allowable spending without using any of these words,
// and the attempt cap already bounds what a husk can cost.
function allowableSource(raw: string): { excerpt: string; anchored: boolean } {
  for (const re of SECTION_PATTERNS) {
    const m = re.exec(raw);
    if (!m) continue;
    // Start a little BEFORE the heading: the heading line itself is often the strongest
    // evidence a section exists, and a window that begins after it throws that away.
    const start = Math.max(0, m.index - 500);
    return { excerpt: raw.slice(start, start + WINDOW_CHARS), anchored: true };
  }
  return { excerpt: raw.slice(0, HEAD_CHARS), anchored: false };
}

// THE NORMALIZER — the whole gate turns on this, so it is spelled out.
//
// raw_text is extracted from PDFs and HTML, and extraction leaves artifacts that no human
// would call a difference in the text: a sentence broken across a line, a soft hyphen at a
// page break, a non-breaking space in a heading, curly quotes from a word processor, an
// en-dash in a range. A model that copies a span perfectly faithfully still fails a
// byte-exact includes() against any of those.
//
// So both sides are folded identically and the match stays EXACT on the folded forms. This
// is not fuzzy matching: there is no similarity score, no threshold, no partial credit, no
// token overlap. A quote either appears in the document or it does not. We are only removing
// distinctions that exist in the encoding rather than in the writing.
//
// Deliberately NOT case-folded. Case is part of the text, models reproduce it reliably, and
// folding it would let "SHALL NOT" match "shall not" -- a difference that changes meaning.
function normalizeForMatch(s: string): string {
  return (
    s
      // Soft hyphen, zero-width space/non-joiner/joiner, BOM, word joiner.
      .replace(/[­​‌‍﻿⁠]/g, "")
      // Hyphenation across a line break: "appropri-\nate" is one word in the source.
      .replace(/-[\r\n]+\s*/g, "")
      // Curly quotes and primes to ASCII.
      .replace(/[‘’‚‛′]/g, "'")
      .replace(/[“”„‟″]/g, '"')
      // Dash family (figure, en, em, minus, non-breaking hyphen) to ASCII hyphen.
      .replace(/[‐‑‒–—―−]/g, "-")
      // Ellipsis to three dots, so a quote that spells it either way still matches.
      .replace(/…/g, "...")
      // Every whitespace run -- including NBSP and newlines -- to one space.
      .replace(/[\s ]+/g, " ")
      .trim()
  );
}

function tidyLine(s: string): string {
  return s
    .trim()
    .replace(/^[-*•\d.)\s]+/, "")
    .replace(/[\s ]+/g, " ")
    .replace(/[.;,]+$/, "")
    .trim();
}

export interface VerifyOutcome {
  kept: AllowableUseItem[];
  returned: number;
  // Dropped under the normalized gate -- the one that decides what ships.
  droppedNormalized: number;
  // How many WOULD have survived a byte-exact match against un-normalized raw_text. Carried
  // only so the sweep can log both numbers side by side for the first week: the question
  // "is normalization doing real work or hiding a hallucination problem" is answerable from
  // the gap between these two, and from nothing else. Never gates anything.
  keptStrict: number;
}

// Apply the gate. Exact containment on the normalized forms; anything not found is dropped.
//
// Shape rules are applied BEFORE the match so a malformed item is never counted as a
// verification failure -- a 3-character quote failing is a schema problem, not evidence
// about faithfulness, and conflating them would poison the drop-rate number this whole
// exercise exists to measure.
export function verifyAllowableUses(raw: string, items: AllowableUseItem[]): VerifyOutcome {
  const haystackNormalized = normalizeForMatch(raw);
  const kept: AllowableUseItem[] = [];
  let keptStrict = 0;
  let droppedNormalized = 0;
  const seen = new Set<string>();

  for (const item of items.slice(0, MAX_ITEMS)) {
    const line = tidyLine(String(item?.line ?? ""));
    const quote = String(item?.quote ?? "").trim();
    if (!line || line.split(/\s+/).length > MAX_LINE_WORDS) continue;
    if (quote.length < MIN_QUOTE_CHARS || quote.length > MAX_QUOTE_CHARS) continue;

    const key = line.toLowerCase();
    if (seen.has(key)) continue;

    // The gate. Both sides folded the same way, then exact containment.
    if (!haystackNormalized.includes(normalizeForMatch(quote))) {
      droppedNormalized++;
      continue;
    }
    // Measured, never enforced. See VerifyOutcome.keptStrict.
    if (raw.includes(quote)) keptStrict++;

    seen.add(key);
    kept.push({ line, quote });
  }

  return { kept, returned: items.length, droppedNormalized, keptStrict };
}

interface ToolPayload {
  has_section?: boolean;
  items?: { line?: string; quote?: string }[];
}

// Generate and verify. Returns the value to STORE, or null meaning "leave the column alone
// and retry later" -- the same contract as generateGrantBrief.
//
// A verified-empty result is NOT null. A NOFO with no allowable-costs section is a real
// answer, and returning null for it would leave the row in the claim window to be re-asked
// every hour forever. That is the loop 0071 had to add an attempt cap to escape; this path
// does not create it in the first place.
export async function generateAllowableUses(
  grant: AllowableUsesGrant,
): Promise<{ value: AllowableUses; audit: VerifyOutcome | null } | null> {
  const raw = (grant.raw_text || "").trim();
  // Nothing to verify against. Not a model failure and not retryable -- store the reason so
  // it is visible as its own category rather than looking like a bad extraction.
  if (!raw) return { value: { items: [], reason: "no_raw_text" }, audit: null };

  const { excerpt, anchored } = allowableSource(raw);

  let payload: ToolPayload;
  try {
    const client = getAnthropicClient();
    const res = await client.messages.create({
      model: MODEL,
      max_tokens: 2000,
      system: SYSTEM,
      tools: [
        {
          name: "submit_allowable_uses",
          description: "Return the allowable uses of funds, each with a verbatim supporting quote. Call exactly once.",
          input_schema: {
            type: "object",
            properties: {
              has_section: {
                type: "boolean",
                description: "True only if the excerpt contains a passage establishing what funds may be spent on.",
              },
              items: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    line: { type: "string" },
                    quote: { type: "string" },
                  },
                  required: ["line", "quote"],
                },
              },
            },
            required: ["has_section", "items"],
          },
        },
      ],
      tool_choice: { type: "tool", name: "submit_allowable_uses" },
      messages: [
        {
          role: "user",
          content:
            `Grant: ${grant.title ?? "(untitled)"}\nFunder: ${grant.funder ?? "(unknown)"}\n` +
            `Excerpt ${anchored ? "centred on the allowable-costs section" : "from the start of the notice"}:\n\n` +
            `${excerpt}\n\nExtract the allowable uses now.`,
        },
      ],
    });
    const toolUse = res.content.find((b) => b.type === "tool_use");
    if (!toolUse || toolUse.type !== "tool_use") return null;
    payload = toolUse.input as ToolPayload;
  } catch {
    // Transient API failure. Retryable -- costs an attempt, writes nothing.
    return null;
  }

  if (payload.has_section === false) return { value: { items: [], reason: "no_section" }, audit: null };

  const raws = (payload.items ?? []).map((i) => ({ line: String(i?.line ?? ""), quote: String(i?.quote ?? "") }));
  const audit = verifyAllowableUses(raw, raws);

  // The model claimed a section and produced lines, and not one of them survived. Recorded
  // as its own reason rather than collapsed into 'no_section': this is the case that says
  // something about the model or the extraction, and it is the number worth watching.
  if (audit.kept.length === 0) return { value: { items: [], reason: "all_dropped" }, audit };

  return { value: { items: audit.kept, reason: null }, audit };
}

// Write a generated result. Only ever called with a real value (including a verified-empty
// one), so allowable_uses_at advances on success only.
async function saveAllowableUses(db: SupabaseClient, grantId: string, value: AllowableUses): Promise<void> {
  const { error } = await db
    .from("grants")
    .update({ allowable_uses: value, allowable_uses_at: new Date().toISOString() })
    .eq("id", grantId);
  if (error) throw new Error(`Failed to save allowable uses: ${error.message}`);
}

const SELECT = "id, title, funder, raw_text, allowable_uses_attempts";

type SweepRow = AllowableUsesGrant & { allowable_uses_attempts: number | null };

// DUPLICATED IN THE INDEX PREDICATE (migration 0072). Raising this REQUIRES a new migration
// widening grants_allowable_uses_pending_idx to match -- see the note there and 0071's
// history for what happens when they drift.
const MAX_ALLOWABLE_USES_ATTEMPTS = 3;

// Never throws: one row's failed bump must not fail the run. Read-then-write is safe here
// for the same reason it is in brief.ts -- hourly cron, maxDuration 300s, no self-overlap.
async function recordFailedAttempt(db: SupabaseClient, grantId: string, current: number | null): Promise<void> {
  const { error } = await db
    .from("grants")
    .update({ allowable_uses_attempts: (current ?? 0) + 1 })
    .eq("id", grantId);
  if (error) console.error(`[allowable-uses] attempt bump failed grant=${grantId}: ${error.message}`);
}

// Null rather than a throw: this runs after every write has committed, and a diagnostic must
// never be able to fail the work it describes. Prints as "?" -- unknown, not zero.
async function countParked(db: SupabaseClient): Promise<number | null> {
  const { count, error } = await db
    .from("grants")
    .select("id", { count: "exact", head: true })
    .is("allowable_uses", null)
    .gte("allowable_uses_attempts", MAX_ALLOWABLE_USES_ATTEMPTS);
  if (error) {
    console.error(`[allowable-uses] parked count failed: ${error.message}`);
    return null;
  }
  return count ?? 0;
}

export interface AllowableUsesSweepResult {
  processed: number;
  // Rows that got a list with at least one verified item.
  written: number;
  // Rows stored as verified-empty, split by reason -- the three cases the reason field
  // exists to keep apart.
  noSection: number;
  noRawText: number;
  allDropped: number;
  // Generation failed or returned nothing usable. Costs an attempt, writes nothing, retries.
  failed: number;
  more: boolean;
  parked: number | null;
  // THE DROP RATE, BOTH WAYS, aggregated across the run. quotesReturned is every item the
  // model produced; quotesKept survived the normalized gate; quotesKeptStrict would have
  // survived byte-exact matching. The gap between the last two is the measurement Shannon
  // asked for: it is the cost of extraction artifacts, isolated from faithfulness.
  quotesReturned: number;
  quotesKept: number;
  quotesKeptStrict: number;
}

// Bounded backfill sweep. Claims the oldest grants with no list, generates in small batches,
// writes only real results. Idempotent: a written grant never reappears (including a
// verified-empty one), and a failure retries next run because allowable_uses_at is not
// advanced.
export async function sweepAllowableUses(
  db: SupabaseClient,
  opts: { cap: number; batchSize?: number },
): Promise<AllowableUsesSweepResult> {
  const batchSize = opts.batchSize ?? 5;

  const { data, error } = await db
    .from("grants")
    .select(SELECT)
    .is("allowable_uses", null)
    .lt("allowable_uses_attempts", MAX_ALLOWABLE_USES_ATTEMPTS)
    .order("ingested_at", { ascending: true })
    .limit(opts.cap);
  if (error) throw new Error(`Allowable-uses sweep query failed: ${error.message}`);

  const pending = (data ?? []) as SweepRow[];
  const result: AllowableUsesSweepResult = {
    processed: pending.length,
    written: 0,
    noSection: 0,
    noRawText: 0,
    allDropped: 0,
    failed: 0,
    more: pending.length === opts.cap,
    parked: null,
    quotesReturned: 0,
    quotesKept: 0,
    quotesKeptStrict: 0,
  };

  for (let i = 0; i < pending.length; i += batchSize) {
    const batch = pending.slice(i, i + batchSize);
    const settled = await Promise.allSettled(
      batch.map(async (g) => {
        // The try wraps GENERATION ONLY, as in brief.ts: a throw here is the same outcome as
        // a null for this row, so it costs an attempt. A save failure below is deliberately
        // not caught the same way -- the result was produced, so a write error is a real
        // fault, logged and retried without spending an attempt.
        let out: Awaited<ReturnType<typeof generateAllowableUses>> = null;
        try {
          out = await generateAllowableUses(g);
        } catch (e) {
          console.error(`[allowable-uses] generation threw grant=${g.id}:`, e instanceof Error ? e.message : e);
        }
        if (!out) {
          await recordFailedAttempt(db, g.id, g.allowable_uses_attempts);
          return { ok: false as const };
        }

        // PER-GRANT DROP LINE. Logged per row rather than only in aggregate because the
        // aggregate cannot tell you WHICH notice the drops came from, and the first week's
        // job is to look at the outliers.
        if (out.audit) {
          const { returned, kept, keptStrict, droppedNormalized } = out.audit;
          console.log(
            `[allowable-uses] grant=${g.id} returned=${returned} kept=${kept.length} ` +
              `dropped=${droppedNormalized} | byte-exact would keep ${keptStrict}` +
              (keptStrict < kept.length ? ` (+${kept.length - keptStrict} recovered by normalization)` : ""),
          );
        }

        try {
          await saveAllowableUses(db, g.id, out.value);
        } catch (e) {
          console.error(`[allowable-uses] save failed grant=${g.id}:`, e instanceof Error ? e.message : e);
          return { ok: false as const };
        }
        return { ok: true as const, value: out.value, audit: out.audit };
      }),
    );

    for (const s of settled) {
      if (s.status !== "fulfilled" || !s.value.ok) {
        result.failed++;
        continue;
      }
      const { value, audit } = s.value;
      if (audit) {
        result.quotesReturned += audit.returned;
        result.quotesKept += audit.kept.length;
        result.quotesKeptStrict += audit.keptStrict;
      }
      if (value.reason === "no_section") result.noSection++;
      else if (value.reason === "no_raw_text") result.noRawText++;
      else if (value.reason === "all_dropped") result.allDropped++;
      else result.written++;
    }
  }

  result.parked = await countParked(db);
  return result;
}

// Client visibility, off unless the value is exactly "true" -- same shape as
// canSendEmail()'s EMAIL_SENDING_ENABLED and pursuitClientAccessEnabled(). Unset, empty,
// "1", "TRUE" and "false" all read as off, because the failure that matters is showing a
// client a list whose drop rate we have not looked at yet.
//
// Read SERVER-SIDE and passed down as a prop, never NEXT_PUBLIC_: inlining it at build time
// would turn the switch into a redeploy.
export function allowableUsesClientVisible(): boolean {
  return process.env.ALLOWABLE_USES_CLIENT_VISIBLE === "true";
}

// Parse the stored column. Returns null when there is nothing to render at all, so a caller
// can decide between the fallback sentinel and omitting the section.
//
// TOLERANT BY DESIGN. jsonb is schemaless and this column will outlive the current shape, so
// anything unrecognised reads as "no list" rather than throwing inside a page render.
export function readAllowableUses(value: unknown): AllowableUses | null {
  if (!value || typeof value !== "object") return null;
  const v = value as { items?: unknown; reason?: unknown };
  if (!Array.isArray(v.items)) return null;
  const items: AllowableUseItem[] = [];
  for (const raw of v.items) {
    if (!raw || typeof raw !== "object") continue;
    const { line, quote } = raw as { line?: unknown; quote?: unknown };
    if (typeof line !== "string" || !line.trim()) continue;
    items.push({ line: line.trim(), quote: typeof quote === "string" ? quote : "" });
  }
  const reason =
    v.reason === "no_section" || v.reason === "no_raw_text" || v.reason === "all_dropped" ? v.reason : null;
  return { items, reason };
}
