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
// A second window, when a strong cluster of headings sits outside the primary one. Smaller
// than the primary because it is the hedge, not the main read: allowable costs and funding
// restrictions are sometimes pages apart, and a single window has to pick one.
const SECOND_WINDOW_CHARS = 8000;
// Fallback window when no heading matches, taken from the head like the brief's excerpt.
const HEAD_CHARS = 10000;
// Below this, a document has no room for a real allowable-costs section -- it is a
// Grants.gov synopsis or a forecast stub, not a NOFO. Used ONLY by the recut to skip rows
// that cannot benefit from better anchoring; generation itself never applies it, because a
// short document with a real section should still be read.
//
// 20k is where the corpus splits cleanly: grants that produced a list average ~45k chars,
// grants that came back no_section average ~15k, and 403 of the 468 no_section rows sit
// under this line.
const RECUT_MIN_RAW_CHARS = 20000;

// The headings a federal NOFO actually uses for this section. Deliberately broad and
// deliberately including the NEGATIVE forms ("unallowable", "funding restrictions"): those
// sections sit adjacent to the allowable list far more often than not, so anchoring on them
// still lands the window in the right place.
//
// GLOBAL, because the scorer needs EVERY occurrence, not the first. The first version took
// the first match of the first pattern that hit anywhere in the document, which let a
// table-of-contents line beat the real section by forty thousand characters.
const SECTION_PATTERNS = [
  /allowable\s+(?:costs?|uses?|activities|expenses?)/gi,
  /unallowable\s+(?:costs?|uses?|activities|expenses?)/gi,
  /funding\s+restrictions?/gi,
  /use\s+of\s+(?:grant\s+)?funds?/gi,
  /eligible\s+(?:costs?|uses?|activities|expenses?)/gi,
  /cost\s+principles?/gi,
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
  // Which pass produced this row. Absent on rows written by the original sweep; 1 once the
  // anchoring recut has looked at it.
  //
  // A MARKER RATHER THAN A TIMESTAMP CUTOFF, which is where this departs from brief.ts's
  // THIN_BRIEF_CUTOFF. That constant had to be the moment the new code reached production --
  // a value you can only know after deploying, and one that silently claims nothing (or
  // everything) if you guess it wrong. A marker in the row is exact, needs no deploy-time
  // knowledge, and makes the recut self-limiting: every row it touches leaves the window for
  // good, so the phase costs nothing once drained.
  recut?: number;
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
// A TABLE-OF-CONTENTS LINE IS NOT A SECTION, and it was beating the real one.
//
// The measured failure: 43 of the 468 no_section grants had a section heading sitting in
// their raw_text, and the excerpt never showed it to the model. A NOFO's contents page says
// "IV. Allowable Costs .......... 41" at character 2,000, the real section starts at 41,000,
// and a window anchored on the first hit hands over front matter -- so the model answers
// has_section: false and the page renders "Not clearly specified in the NOFO" about a
// document that specifies it in detail.
//
// A contents entry is recognisable by its shape rather than its wording: the line it sits on
// is short and ends in a page number, behind either a dot leader or a column gap.
//
// DELIBERATELY CONSERVATIVE, because density scoring below is the primary defence and this is
// belt-and-braces. A false negative costs nothing -- a surviving contents hit has no cluster
// around it and loses the density vote anyway. A false positive is expensive: it discards a
// real hit, and the discarded hit is likely to be one of the best ones.
//
// Which is exactly what "\s\d{1,4}$" did, caught in test. "...allowable costs are described
// in 2 CFR 200" is a body sentence, and that citation is boilerplate sitting immediately
// beside allowable-costs language in most federal notices -- so a single space before a
// trailing number threw away the highest-value hits in the document. A page number in a real
// contents table is set off by a dot leader or column alignment, never by one space.
function looksLikeTocEntry(raw: string, index: number): boolean {
  const from = raw.lastIndexOf("\n", index) + 1;
  const to = raw.indexOf("\n", index);
  const line = raw.slice(from, to === -1 ? raw.length : to).trim();
  if (line.length > 120) return false;
  // "IV. Allowable Costs .......... 41"
  if (/(?:\.\s?){3,}\s*\d{1,4}$/.test(line)) return true;
  // "Allowable Costs      41" -- column-aligned, two or more spaces or a tab.
  return /(?:\s{2,}|\t)\d{1,4}$/.test(line);
}

// Every heading occurrence in the document, contents entries removed.
function sectionHits(raw: string): number[] {
  const hits: number[] = [];
  for (const re of SECTION_PATTERNS) {
    // Fresh lastIndex per document: these regexes are module-level and global, so a stale
    // lastIndex from a previous grant would silently skip the head of this one.
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(raw)) !== null) {
      if (!looksLikeTocEntry(raw, m.index)) hits.push(m.index);
      // A zero-length match cannot happen with these patterns, but an unguarded global exec
      // loop is one edit away from spinning forever.
      if (m.index === re.lastIndex) re.lastIndex++;
    }
  }
  return hits.sort((a, b) => a - b);
}

// WHERE TO LOOK, and why not the top of the document, and why not the first match either.
//
// The brief's excerpt takes the first 8000 characters, which is right for its job -- the
// shape of a program is established in the opening pages. Allowable costs are not: in a
// federal NOFO they sit in Section B or C, routinely 40k+ characters in.
//
// Selection is by DENSITY, not position. The real section mentions these phrases repeatedly
// within a few pages; a passing reference or a surviving contents line does not. So each hit
// is scored by how many other hits fall inside a window of it, and the densest wins. Ties go
// to the LATER hit, because front matter precedes body text.
//
// A SECOND WINDOW when a strong cluster sits outside the first. "Allowable Costs" and
// "Funding Restrictions" are frequently pages apart, and with one window the loser is
// invisible. Bounded at one extra window so a pathological document cannot inflate the call.
//
// The model still decides whether a real section is present; this only decides where it gets
// to look. And because verification runs against the FULL raw_text rather than the excerpt, a
// window that lands badly can only ever cost lines -- it can never admit a quote that is not
// in the document.
function allowableSource(raw: string): { excerpt: string; anchored: boolean } {
  const hits = sectionHits(raw);
  if (hits.length === 0) return { excerpt: raw.slice(0, HEAD_CHARS), anchored: false };

  const density = (at: number) => hits.filter((h) => Math.abs(h - at) <= WINDOW_CHARS).length;
  let best = hits[0];
  let bestScore = density(best);
  for (const h of hits) {
    const score = density(h);
    // >= so a later hit wins a tie: body text follows front matter.
    if (score >= bestScore) {
      best = h;
      bestScore = score;
    }
  }

  // Start a little BEFORE the heading: the heading line itself is often the strongest
  // evidence a section exists, and a window that begins after it throws that away.
  const start = Math.max(0, best - 500);
  const end = start + WINDOW_CHARS;
  let excerpt = raw.slice(start, end);

  // The hedge. Only for a hit with real company (density >= 2) that the primary window does
  // not already cover -- a lone mention elsewhere is not worth a second read.
  const outside = hits.filter((h) => (h < start || h >= end) && density(h) >= 2);
  if (outside.length > 0) {
    let second = outside[0];
    let secondScore = density(second);
    for (const h of outside) {
      const score = density(h);
      if (score >= secondScore) {
        second = h;
        secondScore = score;
      }
    }
    const s2 = Math.max(0, second - 500);
    // The marker is there so the model cannot read across the join as continuous prose and
    // quote a span that spuriously bridges two pages -- such a quote would fail verification
    // against raw_text anyway, but wasting a line on it is avoidable.
    excerpt += `\n\n[...]\n\n${raw.slice(s2, s2 + SECOND_WINDOW_CHARS)}`;
  }

  return { excerpt, anchored: true };
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

// ── The anchoring recut ─────────────────────────────────────────────────────────────────
//
// WHY A RECUT IS PART OF THE FIX AND NOT A FOLLOW-UP. All 468 no_section rows already have
// allowable_uses written and allowable_uses_at stamped, so the main claim will never touch
// them again. Better anchoring on its own would apply only to grants ingested from here on
// and would leave the existing corpus exactly as wrong as it is now. The measured 43
// recoverable grants are all in that written set.
//
// SCOPED TO DOCUMENTS THAT CAN BENEFIT. 403 of the 468 are synopsis and forecast stubs under
// RECUT_MIN_RAW_CHARS -- re-asking them would spend 403 Anthropic calls to confirm what we
// already know. Those are stamped and retired WITHOUT a call, which is the same
// retire-as-well-as-regenerate discipline requeueThinBriefs needed: a row that cannot improve
// must still leave the window, or the phase never stops costing something.
const RECUT_FLOOR = 5;

// Cheap head-only probe. No rows, and critically no raw_text -- the largest column on the
// table. Runs before the main claim because the answer changes its size.
async function countRecutCandidates(db: SupabaseClient): Promise<number> {
  const { count, error } = await db
    .from("grants")
    .select("id", { count: "exact", head: true })
    .filter("allowable_uses->>reason", "eq", "no_section")
    .filter("allowable_uses->>recut", "is", null);
  if (error) throw new Error(`Recut probe failed: ${error.message}`);
  return count ?? 0;
}

interface RecutResult {
  // Re-read and now carries at least one verified line. The number this phase exists for.
  improved: number;
  // Re-read and still no section. The anchoring was not the problem for these.
  stillEmpty: number;
  // Too short to have a section at all -- stamped, never re-asked, no API call spent.
  retiredShort: number;
  // Generation failed outright. Left unstamped so it is retried next run.
  failed: number;
}

async function recutNoSection(db: SupabaseClient, budget: number): Promise<RecutResult> {
  const out: RecutResult = { improved: 0, stillEmpty: 0, retiredShort: 0, failed: 0 };
  if (budget <= 0) return out;

  const { data, error } = await db
    .from("grants")
    .select("id, title, funder, raw_text, allowable_uses")
    .filter("allowable_uses->>reason", "eq", "no_section")
    .filter("allowable_uses->>recut", "is", null)
    .order("allowable_uses_at", { ascending: true })
    .limit(budget);
  if (error) throw new Error(`Recut claim failed: ${error.message}`);

  const claimed = (data ?? []) as (SweepRow & { allowable_uses: unknown })[];

  for (const g of claimed) {
    const raw = (g.raw_text || "").trim();

    // Retire without a call. Keeps the existing value, adds only the marker, so the row's
    // meaning is unchanged and it simply stops being asked.
    if (raw.length < RECUT_MIN_RAW_CHARS) {
      try {
        await saveAllowableUses(db, g.id, { items: [], reason: "no_section", recut: 1 });
        out.retiredShort++;
      } catch (e) {
        console.error(`[allowable-uses] recut retire failed grant=${g.id}:`, e instanceof Error ? e.message : e);
        out.failed++;
      }
      continue;
    }

    let result: Awaited<ReturnType<typeof generateAllowableUses>> = null;
    try {
      result = await generateAllowableUses(g);
    } catch (e) {
      console.error(`[allowable-uses] recut generation threw grant=${g.id}:`, e instanceof Error ? e.message : e);
    }
    // Unstamped on failure, so a transient API error is retried rather than burning the row's
    // one chance at a better window.
    if (!result) {
      out.failed++;
      continue;
    }

    const improved = result.value.items.length > 0;
    try {
      await saveAllowableUses(db, g.id, { ...result.value, recut: 1 });
    } catch (e) {
      console.error(`[allowable-uses] recut save failed grant=${g.id}:`, e instanceof Error ? e.message : e);
      out.failed++;
      continue;
    }
    // BEFORE/AFTER, per grant. The whole point of the recut is whether the new anchoring
    // actually moves a row that used to read no_section, so the line says which way it went.
    console.log(
      `[allowable-uses] recut grant=${g.id} raw=${raw.length}c ` +
        (improved
          ? `no_section -> ${result.value.items.length} item(s)` +
            (result.audit ? ` (returned ${result.audit.returned}, dropped ${result.audit.droppedNormalized})` : "")
          : `still ${result.value.reason}`),
    );
    if (improved) out.improved++;
    else out.stillEmpty++;
  }

  return out;
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
  // The anchoring recut over rows already written as no_section. All four go to zero
  // permanently once the unmarked window is drained.
  recutImproved: number;
  recutStillEmpty: number;
  recutRetiredShort: number;
  recutFailed: number;
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

  // Probe BEFORE claiming, because the answer changes the main claim's size. Total work per
  // run still never exceeds opts.cap either way, so maxDuration is unaffected.
  //
  // RESERVED CAPACITY, not leftovers. #311 is the record of giving a second phase
  // `cap - claimed`: that is zero on every run where the first phase fills the cap, so the
  // backfill never begins and its 0/0 reads as success rather than starvation. Grants with NO
  // list still come first -- they show nothing at all, which is the worse failure -- but the
  // recut gets its floor.
  //
  // Reserved ONLY when there is something to reserve for, so once the recut window is empty
  // the main claim goes back to the full cap instead of idling slots forever.
  const recutWaiting = await countRecutCandidates(db);
  // The max(cap - 1, 0) floor keeps at least one slot for the main claim: .limit(0) is not
  // dependably "no rows" and would be a silent unbounded claim.
  const reserved = recutWaiting > 0 ? Math.min(RECUT_FLOOR, recutWaiting, Math.max(opts.cap - 1, 0)) : 0;
  const mainCap = opts.cap - reserved;

  const { data, error } = await db
    .from("grants")
    .select(SELECT)
    .is("allowable_uses", null)
    .lt("allowable_uses_attempts", MAX_ALLOWABLE_USES_ATTEMPTS)
    .order("ingested_at", { ascending: true })
    .limit(mainCap);
  if (error) throw new Error(`Allowable-uses sweep query failed: ${error.message}`);

  const pending = (data ?? []) as SweepRow[];
  const result: AllowableUsesSweepResult = {
    processed: pending.length,
    written: 0,
    noSection: 0,
    noRawText: 0,
    allDropped: 0,
    failed: 0,
    // Against mainCap, not opts.cap: with slots reserved for the recut, a full main claim is
    // mainCap rows, and comparing to opts.cap would report more=false on a run that in fact
    // left work behind.
    more: pending.length === mainCap && mainCap > 0,
    parked: null,
    quotesReturned: 0,
    quotesKept: 0,
    quotesKeptStrict: 0,
    recutImproved: 0,
    recutStillEmpty: 0,
    recutRetiredShort: 0,
    recutFailed: 0,
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

  // Reserved slots, plus whatever the main claim left unused on a light run.
  const recut = await recutNoSection(db, reserved + Math.max(mainCap - pending.length, 0));
  result.recutImproved = recut.improved;
  result.recutStillEmpty = recut.stillEmpty;
  result.recutRetiredShort = recut.retiredShort;
  result.recutFailed = recut.failed;
  // more stays true while the recut has anything left, so the drain is visible in one field
  // rather than having to be inferred from the recut counters going quiet.
  if (recutWaiting > recut.improved + recut.stillEmpty + recut.retiredShort) result.more = true;

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
