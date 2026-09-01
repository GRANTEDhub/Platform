import type { SupabaseClient } from "@supabase/supabase-js";
import { getAnthropicClient, MODEL } from "@/lib/anthropic";
import { normalizeForMatch, sectionHits, MIN_QUOTE_CHARS, MAX_QUOTE_CHARS } from "@/lib/grants/nofo-text";

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
// The quote bounds (MIN_QUOTE_CHARS / MAX_QUOTE_CHARS), the normalizer, and the section-heading
// scanner now live in lib/grants/nofo-text.ts, shared verbatim with requirements.ts -- see the
// import above. SECTION_PATTERNS below stay local: they are the allowable-costs headings, distinct
// from the application/review headings requirements.ts anchors on.

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
export const SECTION_PATTERNS = [
  /allowable\s+(?:costs?|uses?|activities|expenses?)/gi,
  /unallowable\s+(?:costs?|uses?|activities|expenses?)/gi,
  /funding\s+restrictions?/gi,
  /use\s+of\s+(?:grant\s+)?funds?/gi,
  /eligible\s+(?:costs?|uses?|activities|expenses?)/gi,
  /cost\s+principles?/gi,
  // The phrasings a modern federal NOFO actually uses, none of which contain "allowable" -- the gap
  // that made the finder fall back to the document head and report no_section on notices that DO
  // carry cost rules. Verified verbatim against three 2026 HHS-ACF NOFOs (the cost rules live under
  // "Program-specific limitations and policies" / "We do not allow the following costs" / "Indirect
  // costs" in Step 1, and the "necessary, reasonable, allocable" budget standard + "funding policies
  // and limitations" / "restrictions on spending" in the Step 3 budget instructions -- pages apart,
  // which the density + second-window selection already handles).
  /funding\s+policies\s+and\s+limitations/gi,
  /program-specific\s+limitations/gi,
  /we\s+do\s+not\s+allow/gi,
  /do\s+not\s+allow\s+the\s+following/gi,
  /not\s+allowable/gi,
  /restrictions?\s+on\s+spending/gi,
  /indirect\s+costs?/gi,
  /de\s+minimis/gi,
  /necessary,?\s+reasonable,?\s+allocable/gi,
  /object\s+class\s+categories/gi,
  /line-item\s+budget/gi,
];

// THE SENTINEL, and it is deliberately not an empty render. A blank section reads as "we
// have not looked"; this says what is true -- the NOFO did not tell us plainly, and a human
// should be asked. Kept here rather than at the render site so both surfaces cannot drift.
export const ALLOWABLE_USES_FALLBACK = "Not clearly specified in the NOFO — Ask our team";

// Why a list came back empty. Stored (not just logged) because items: [] cannot distinguish
// these three, and they are three different problems: the NOFO's, the model's, and ours.
export type AllowableUsesReason = "no_section" | "no_raw_text" | "all_dropped";

// Allowed = what funds MAY be spent on. Not-allowed = a prohibited or restricted cost. A NOFO's
// cost rules are BOTH -- ACF notices, for one, carry the spend rules almost entirely as a "we do
// not allow the following costs" list plus indirect-rate caps, with no "allowable" heading at all,
// so extracting only allowable uses returned nothing on them.
export type UseKind = "allowed" | "not_allowed";

// For a not-allowed item ONLY. BUDGET = a spending restriction a client needs to plan a budget
// (construction, real property, renovation caps, acquisition, fundraising, pre-award, indirect /
// de-minimis caps, salary caps, supplanting). STATUTORY = a whole-award ideological / appropriations
// -rider condition that is NOT budget guidance (bans tied to abortion, gender ideology, sexual
// orientation / gender identity, conversion therapy, and the like). BOTH are extracted and STORED;
// only the CLIENT surface drops STATUTORY -- see clientAllowableUses. Null / absent on allowed items.
export type RestrictionClass = "budget" | "statutory";

export interface AllowableUseItem {
  // The rendered line -- a budget category in plain language.
  line: string;
  // The verbatim NOFO span this line came from. Present in raw_text under normalization, or
  // the item is not here at all.
  quote: string;
  // "allowed" (the default, and the shape of every row written before this field existed) or
  // "not_allowed". readAllowableUses defaults a missing value to "allowed" for back-compat.
  kind: UseKind;
  // Only meaningful when kind === "not_allowed"; null on allowed items and when the model did not
  // classify. The client filter shows a not-allowed item only when this is explicitly "budget".
  restriction_class?: RestrictionClass | null;
}

export interface AllowableUses {
  items: AllowableUseItem[];
  // Null when items is non-empty. Non-null and items empty when there is nothing to show.
  reason: AllowableUsesReason | null;
  // The GENERATION of the finder/extraction that last processed this row (ALLOWABLE_USES_GENERATION).
  // Absent on rows written by the original sweep; a number once a recut has re-processed it. The recut
  // re-runs any no_section row BELOW the current generation, so a finder improvement re-touches the
  // whole no_section corpus simply by bumping the generation constant.
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

const SYSTEM = `You extract the USES OF FUNDS from U.S. federal and state grant notices for GRANTED, a grant-consulting firm.

You are given an excerpt of a notice of funding opportunity (NOFO). List (a) what the money MAY be spent on and (b) what it may NOT be spent on, and prove every line by quoting the notice.

Federal NOFOs rarely use the heading "Allowable Costs". The cost rules usually live under headings like "Funding policies and limitations", "Program-specific limitations and policies", "We do not allow the following costs", "Indirect costs", or in the budget instructions ("necessary, reasonable, allocable ..."). Read those as the cost section -- they are exactly what establishes what funds may and may not be spent on.

For each item, return:
- "line": the spending category in plain language, at most ${MAX_LINE_WORDS} words. No hype, no bullets, no headings, no trailing punctuation.
- "quote": a VERBATIM span copied character-for-character from the excerpt that establishes that line. Between ${MIN_QUOTE_CHARS} and ${MAX_QUOTE_CHARS} characters.
- "kind": "allowed" if funds MAY be used for this; "not_allowed" if the notice prohibits or restricts it.
- "restriction_class": ONLY for a "not_allowed" item. "budget" for a spending restriction a client needs to plan a budget (construction, real property, renovation caps, acquisition, fundraising, pre-award costs, indirect-cost / de-minimis caps, salary caps, supplanting). "statutory" for a whole-award ideological or appropriations-rider condition that is NOT budget guidance (e.g. bans tied to abortion, gender ideology, sexual orientation / gender identity change, conversion therapy, or similar policy conditions). Omit for "allowed" items.

Rules, in order of importance:
1. THE QUOTE MUST BE COPIED, NOT RECONSTRUCTED. Do not fix spelling, expand abbreviations, change punctuation, join lines, or tidy spacing. If you cannot copy a span exactly, omit that line entirely. A line without a real quote is worse than a missing line.
2. Every quote must come from the excerpt you were given. Never quote from memory of similar programs.
3. Classify honestly. An allowed use is something funds MAY pay for -- a funded activity, an allowable cost category, or an allowable indirect rate. A not_allowed item is a prohibition or a cap. When a not_allowed item is an ideological / policy condition rather than a budget rule, mark it "statutory" -- do not omit it, mark it.
4. At most ${MAX_ITEMS} items total across both kinds. Prefer the distinct, substantive categories over exhaustive subdivision.
5. Do not state dollar amounts, deadlines, or match requirements. A percentage CAP that itself defines the restriction (e.g. an indirect de-minimis rate) may be named as part of the line.
6. Do not name any applicant organization or assess anyone's fit. These lists are shown to every client matched to the grant.
7. Set has_section to false ONLY when the excerpt contains no passage establishing what funds may or may not be spent on. A "we do not allow ..." list, an indirect-cost rule, or a "necessary, reasonable, allocable" budget standard all COUNT as a cost section -- returning items for them is the correct answer. An excerpt that only describes program goals, with no cost or spending language at all, is not a cost section.

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
// sectionHits (every heading occurrence, contents-page entries removed) and its
// looksLikeTocEntry helper now live in lib/grants/nofo-text.ts, shared with requirements.ts. The
// TOC-detection rationale and the "\s\d{1,4}$" regression that shaped it are documented there.
//
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
export function allowableSource(raw: string): { excerpt: string; anchored: boolean } {
  const hits = sectionHits(raw, SECTION_PATTERNS);
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

  // Anchor the window on the START of the winning cluster, not on `best`. The >= tie rule above puts
  // `best` at the cluster's LAST hit (later beats earlier), so a tight cluster smaller than the window
  // -- e.g. an ACF cost section whose "we do not allow ..." list, indirect-cost rule and budget
  // standard all fall within ~2k chars -- would anchor at its tail and clip the opening list, handing
  // the model only the budget standard at the end. Take the earliest hit within one window of `best`
  // and start a little before it, so the whole cluster (heading included) is in view.
  const clusterStart = Math.min(...hits.filter((h) => Math.abs(h - best) <= WINDOW_CHARS));
  const start = Math.max(0, clusterStart - 500);
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

// normalizeForMatch (the encoding fold the quote gate turns on) now lives in
// lib/grants/nofo-text.ts, imported above and shared verbatim with requirements.ts.

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
    const kind = normalizeKind(item?.kind);
    const restriction_class = normalizeRestrictionClass(kind, item?.restriction_class);
    if (!line || line.split(/\s+/).length > MAX_LINE_WORDS) continue;
    if (quote.length < MIN_QUOTE_CHARS || quote.length > MAX_QUOTE_CHARS) continue;

    // Keyed on kind + line so the same phrasing can appear once as allowed and once as not-allowed
    // (rare, but a legitimate "indirect costs allowed up to X / may not charge indirect as direct").
    const key = `${kind}:${line.toLowerCase()}`;
    if (seen.has(key)) continue;

    // The gate. Both sides folded the same way, then exact containment. Unchanged by the two lists --
    // a not-allowed line is quote-verified exactly like an allowed one.
    if (!haystackNormalized.includes(normalizeForMatch(quote))) {
      droppedNormalized++;
      continue;
    }
    // Measured, never enforced. See VerifyOutcome.keptStrict.
    if (raw.includes(quote)) keptStrict++;

    seen.add(key);
    kept.push({ line, quote, kind, restriction_class });
  }

  return { kept, returned: items.length, droppedNormalized, keptStrict };
}

interface ToolPayload {
  has_section?: boolean;
  items?: { line?: string; quote?: string; kind?: string; restriction_class?: string }[];
}

// Normalize the model's kind / restriction_class into the stored shape. A missing/unknown kind is
// "allowed" (the pre-two-list default); restriction_class is kept only for a not_allowed item and
// only when the model actually classified it -- an unclassified not_allowed stays null, which the
// client filter treats as "do not surface" (fail toward hiding a possibly-statutory item).
function normalizeKind(k: unknown): UseKind {
  return k === "not_allowed" ? "not_allowed" : "allowed";
}
function normalizeRestrictionClass(kind: UseKind, rc: unknown): RestrictionClass | null {
  if (kind !== "not_allowed") return null;
  return rc === "statutory" ? "statutory" : rc === "budget" ? "budget" : null;
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
          description: "Return the uses of funds (allowed and not-allowed), each with a verbatim supporting quote. Call exactly once.",
          input_schema: {
            type: "object",
            properties: {
              has_section: {
                type: "boolean",
                description:
                  "True if the excerpt contains any passage establishing what funds may or may not be spent on.",
              },
              items: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    line: { type: "string" },
                    quote: { type: "string" },
                    kind: {
                      type: "string",
                      enum: ["allowed", "not_allowed"],
                      description: "allowed = funds may be used for this; not_allowed = prohibited or restricted.",
                    },
                    restriction_class: {
                      type: "string",
                      enum: ["budget", "statutory"],
                      description:
                        "Only for not_allowed items. budget = a spending restriction for budgeting; statutory = an ideological / appropriations-rider condition.",
                    },
                  },
                  required: ["line", "quote", "kind"],
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

  // A NON-ARRAY `items` IS A MODEL FAILURE, NOT AN EMPTY LIST. `?? []` guarded null and
  // undefined but not a wrong type, so a payload whose items came back as an object or a
  // string threw ".map is not a function" -- caught upstream as "generation threw", which
  // costs an attempt and writes nothing. Observed live on two grants across three runs; one
  // of them burned two of its three attempts before a re-ask happened to return a
  // well-formed array, so it cleared the cap by luck rather than by design.
  //
  // RETRYABLE RATHER THAN STORED, and deliberately NOT folded into all_dropped. That reason
  // means "the model produced lines and not one survived verification" -- the faithfulness
  // signal being watched this week. Recording a schema failure there would corrupt the one
  // number this sweep exists to measure. Returning null keeps the retry that demonstrably
  // recovers these, and the three-attempt cap still parks a persistent offender.
  //
  // The type and a truncated value are logged because the tool schema declares items an
  // array: if this recurs, the actual shape is the only useful evidence.
  if (!Array.isArray(payload.items)) {
    console.error(
      `[allowable-uses] malformed items grant=${grant.id} type=${typeof payload.items} ` +
        `value=${JSON.stringify(payload.items)?.slice(0, 200) ?? "undefined"}`,
    );
    return null;
  }

  const raws: AllowableUseItem[] = payload.items.map((i) => {
    const kind = normalizeKind(i?.kind);
    return {
      line: String(i?.line ?? ""),
      quote: String(i?.quote ?? ""),
      kind,
      restriction_class: normalizeRestrictionClass(kind, i?.restriction_class),
    };
  });
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
//
// TWO PHASES ON TWO BUDGETS, because sharing one starved the phase that mattered. The recut
// ran both kinds of row through the same RECUT_FLOOR slots in allowable_uses_at order, and
// retiring a stub costs nothing at the API -- so five free retirements per hour consumed the
// whole allowance while the 43 improvable grants sat behind 403 stubs. Measured in the
// 18:52-23:52 sweep window: `recut improved 0, retired-short 5` on six consecutive runs, i.e.
// ~80 hours before the first recoverable row would even be reached. Retirement is now a bulk
// pass with its own (much larger) scan, and the API slots are spent only on rows long enough
// to have a section.
const RECUT_FLOOR = 5;

// How many unmarked no_section rows the FREE pass may look at per run. Bounded only by the
// cost of reading raw_text -- the largest column on the table -- not by anything at the API,
// so it is two orders of magnitude above RECUT_FLOOR. At 100/run the 403 stubs drain in about
// four runs instead of eighty, and the improvable rows surface behind them.
//
// A cheaper filter is possible but not worth a migration: PostgREST cannot filter on
// length(raw_text), so the length test happens in memory here. A generated raw_text_len
// column would make this pass free to scan if the window ever grows past a few hundred rows.
const RECUT_SCAN_BATCH = 100;

// Rows per retire statement. See the chunking note in recutNoSection: `.in()` travels in the
// URL, so this bounds the request line rather than anything about the work itself.
const RETIRE_CHUNK = 50;

// The generation of this file's finder + extraction, STORED on each row as `recut`. Bumped to 2 when
// SECTION_PATTERNS were widened to the ACF-style headings ("we do not allow", "funding policies and
// limitations", "indirect costs", "necessary, reasonable, allocable") and extraction began returning
// not-allowed items -- so every no_section row a v1 build wrote (recut null or 1) is re-run once under
// v2 and re-stamped. Bump again for any future finder/prompt change that should re-touch the
// already-processed no_section corpus. Kept single-digit: the recut scan compares `recut` as TEXT
// (PostgREST `.lt`), and "1" < "2" holds lexically only while the numbers are single digits.
const ALLOWABLE_USES_GENERATION = 2;

// The recut scan predicate: a no_section row whose generation is BELOW the current one -- absent
// (never recut) OR an older generation number. Shared by the probe and the scan so they can't drift.
const RECUT_STALE_OR = `allowable_uses->>recut.is.null,allowable_uses->>recut.lt.${ALLOWABLE_USES_GENERATION}`;

// Cheap head-only probe. No rows, and critically no raw_text -- the largest column on the
// table. Runs before the main claim because the answer changes its size.
async function countRecutCandidates(db: SupabaseClient): Promise<number> {
  const { count, error } = await db
    .from("grants")
    .select("id", { count: "exact", head: true })
    .filter("allowable_uses->>reason", "eq", "no_section")
    .or(RECUT_STALE_OR);
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

async function recutNoSection(db: SupabaseClient, apiBudget: number): Promise<RecutResult> {
  const out: RecutResult = { improved: 0, stillEmpty: 0, retiredShort: 0, failed: 0 };

  // ── Phase A: retire the stubs. No API calls, so this is not charged to apiBudget. ────────
  const { data, error } = await db
    .from("grants")
    .select("id, title, funder, raw_text")
    .filter("allowable_uses->>reason", "eq", "no_section")
    .or(RECUT_STALE_OR)
    .order("allowable_uses_at", { ascending: true })
    .limit(RECUT_SCAN_BATCH);
  if (error) throw new Error(`Recut scan failed: ${error.message}`);

  const scanned = (data ?? []) as AllowableUsesGrant[];
  const shortIds: string[] = [];
  const longEnough: AllowableUsesGrant[] = [];
  for (const g of scanned) {
    if ((g.raw_text || "").trim().length < RECUT_MIN_RAW_CHARS) shortIds.push(g.id);
    else longEnough.push(g);
  }

  // SET-AT-A-TIME, not row-at-a-time. Every row here is already {items: [], reason:
  // no_section}, so the written value is identical across them -- the update adds the marker
  // and changes nothing else about their meaning. Per-row writes would be 403 round trips to
  // say the same thing.
  //
  // Chunked because `.in()` becomes an `id=in.(...)` QUERY STRING, not a body: 100 UUIDs is
  // ~3.7KB of URL, close enough to the usual 8KB request-line ceiling that a bigger scan batch
  // would start returning 414 instead of working. Chunks of 50 keep it around 1.9KB, and one
  // failed chunk leaves its rows unstamped for the next run rather than poisoning the others.
  for (let i = 0; i < shortIds.length; i += RETIRE_CHUNK) {
    const chunk = shortIds.slice(i, i + RETIRE_CHUNK);
    const { error: bulkErr } = await db
      .from("grants")
      .update({
        allowable_uses: { items: [], reason: "no_section", recut: ALLOWABLE_USES_GENERATION },
        allowable_uses_at: new Date().toISOString(),
      })
      .in("id", chunk);
    if (bulkErr) {
      // Counted as failures, not silently swallowed: unstamped rows stay in the window and
      // are simply rescanned next run, so this is recoverable rather than lost.
      console.error(`[allowable-uses] recut bulk retire failed (${chunk.length} rows): ${bulkErr.message}`);
      out.failed += chunk.length;
    } else {
      out.retiredShort += chunk.length;
    }
  }

  // ── Phase B: re-ask the documents that can actually improve, bounded by the API budget ───
  //
  // Anything past the budget stays unmarked and is picked up next run. That costs a repeated
  // raw_text read for those rows, which is the accepted price of not stamping a row we have
  // not actually re-read.
  for (const g of longEnough.slice(0, Math.max(apiBudget, 0))) {
    const raw = (g.raw_text || "").trim();

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
      await saveAllowableUses(db, g.id, { ...result.value, recut: ALLOWABLE_USES_GENERATION });
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

  // Reserved slots, plus whatever the main claim left unused on a light run. Skipped entirely
  // when nothing is waiting, so the steady state costs neither the scan nor the raw_text read
  // once the window is drained.
  const recut =
    recutWaiting > 0
      ? await recutNoSection(db, reserved + Math.max(mainCap - pending.length, 0))
      : { improved: 0, stillEmpty: 0, retiredShort: 0, failed: 0 };
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
    const { line, quote, kind, restriction_class } = raw as {
      line?: unknown;
      quote?: unknown;
      kind?: unknown;
      restriction_class?: unknown;
    };
    if (typeof line !== "string" || !line.trim()) continue;
    // A row written before the two-list change has no kind -> "allowed", so every legacy list keeps
    // rendering exactly as it did (all-allowed).
    const k = normalizeKind(kind);
    items.push({
      line: line.trim(),
      quote: typeof quote === "string" ? quote : "",
      kind: k,
      restriction_class: normalizeRestrictionClass(k, restriction_class),
    });
  }
  const reason =
    v.reason === "no_section" || v.reason === "no_raw_text" || v.reason === "all_dropped" ? v.reason : null;
  return { items, reason };
}

// Ideological / policy wording that must never surface on a CLIENT card, even if the model tagged the
// item "budget". A whole-award statutory condition (no abortion, no gender-ideology work, etc.) is not
// budget guidance and is jarring on a client deliverable. This deterministic net sits UNDER the model's
// restriction_class so a single mistag can't leak one through. Staff/console are unaffected -- they
// read the full stored list. Kept deliberately narrow (the recurring federal-rider terms), matched
// against BOTH the plain line and its quote.
const STATUTORY_CLIENT_HIDE =
  /\b(abortion|gender\s+ideolog|sexual\s+orientation|gender\s+identity|conversion\s+therapy|transgender)\b/i;

// Client visibility, RESOLVED. What the portal's grant detail passes to the shared review console for
// a CLIENT: the parsed uses-of-funds list, FILTERED to what is client-appropriate, or null to omit the
// section entirely.
//
// TWO GATES, both must pass -- the ALLOWABLE_USES_CLIENT_VISIBLE flag is on AND, after filtering, the
// list still has items. A verified-empty result (a NOFO that truly established no cost rules) returns
// null here, so a client sees NO section rather than the "Ask our team" sentinel.
//
// CLIENT-SURFACE FILTER, NOT A DELETION. Every allowed item is client-safe. A not-allowed item shows
// to a client ONLY as an explicit BUDGET restriction (what they need to plan a budget) and NEVER when
// it is a STATUTORY / ideological condition -- those stay in the stored column for staff and any other
// use, but are dropped from the client card here (Shannon's call: budget-planning info, not policy
// riders). Two layers: the model's restriction_class, then the deterministic STATUTORY_CLIENT_HIDE net
// beneath it. STAFF keep the full list -- the roadmap calls readAllowableUses() unconditionally.
export function clientAllowableUses(value: unknown): AllowableUses | null {
  if (!allowableUsesClientVisible()) return null;
  const parsed = readAllowableUses(value);
  if (!parsed) return null;
  const items = parsed.items.filter((it) => {
    if (it.kind !== "not_allowed") return true;
    if (it.restriction_class !== "budget") return false;
    if (STATUTORY_CLIENT_HIDE.test(it.line) || STATUTORY_CLIENT_HIDE.test(it.quote)) return false;
    return true;
  });
  return items.length > 0 ? { ...parsed, items } : null;
}
