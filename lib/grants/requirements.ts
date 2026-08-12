import type { SupabaseClient } from "@supabase/supabase-js";
import { getAnthropicClient, MODEL } from "@/lib/anthropic";

// WHAT AN APPLICATION TO THIS PROGRAM MUST CONTAIN, read off the NOFO and quote-verified
// against raw_text (migration 0081). Step 4 of the Pursuit build order.
//
// SIBLING TO allowable-uses.ts, SAME DISCIPLINE. Grant-level not client-level; enrichment only;
// every derived line ships with the verbatim NOFO span it came from and is DROPPED unless that
// span is actually present in raw_text. Nothing in the occupancy/seat scorer reads this. The
// difference from allowable-uses is the trigger, not the gate: this is derived LAZILY, on the
// first compliance-step open for a grant actually being pursued, by a staff-gated route -- not
// by a corpus-wide hourly sweep -- so there is no pending index and no backfill.
//
// WHY THE QUOTE. A requirements checklist reads as a statement of fact about what a funder will
// demand, and a client scopes work against it. A line that is merely plausible is worse than no
// line, because it looks like it came from the NOFO. So every line carries its span and is
// verified against the FULL raw_text; a window that lands badly can only cost recall, never
// admit a quote that is not in the document.
//
// WHAT IS DELIBERATELY NOT DERIVED HERE. Eligibility, deadlines and match/cost-share are already
// held as VERIFIED grant columns (eligible_entity_types / geographic_eligibility read by
// computeEligibility; submission_deadline / deadline; cost_share). Re-extracting them can only
// produce "same" (noise) or "contradiction" (a second, disagreeing source of truth), so the
// extractor is told NOT to return them. The compliance step surfaces those from the existing
// columns, and eligibility stays owned solely by the eligibility card.

// A field is a list of at most this many items -- a NOFO can require many attachments, but a
// client reading a card needs the shape of it, not a transcription.
const MAX_ITEMS_PER_FIELD = 15;
// A requirement line is a clause, not a paragraph -- slightly longer than allowable-uses' budget
// line because "a five-page narrative on X, Y and Z" legitimately runs longer than a category.
const MAX_TEXT_WORDS = 40;
// Same quote bounds as allowable-uses: long enough to carry a real clause, short enough that "the
// quote" cannot become "the section"; below the floor a span matches by accident in any long doc.
const MAX_QUOTE_CHARS = 300;
const MIN_QUOTE_CHARS = 24;

// How much NOFO text to hand the model. Requirements are spread across a federal NOFO's
// application (Section IV) and review (Section V) sections rather than clustered like allowable
// costs, so this reads the head plus up to two anchored windows rather than one dense window.
const HEAD_CHARS = 12000;
const WINDOW_CHARS = 12000;
const MAX_ANCHORED_WINDOWS = 2;

// The headings a federal/state NOFO uses for the sections that carry application requirements.
// GLOBAL so every occurrence is found, not just the first.
const SECTION_PATTERNS = [
  /application\s+and\s+submission/gi,
  /content\s+and\s+form\s+of\s+(?:the\s+)?application/gi,
  /page\s+limit/gi,
  /application\s+review\s+information/gi,
  /(?:review|evaluation|scoring)\s+criteria/gi,
  /required\s+(?:documents?|attachments?|forms?)/gi,
  /submission\s+(?:requirements?|instructions?|dates?)/gi,
  /format(?:ting)?\s+(?:requirements?|instructions?)/gi,
];

// The reason a value came back with empty lists. Stored, not just logged, because empty is
// ambiguous: the NOFO could not be read, or it was read and states no explicit requirements, or
// it stated some and every one failed quote verification -- three different problems.
export type RequirementsReason = "nofo_not_retrievable" | "no_requirements_found" | "all_dropped";

export interface RequirementItem {
  // The rendered line, in the NOFO's terms.
  text: string;
  // The verbatim NOFO span this line came from. Present in raw_text under normalization, or the
  // item is not here at all.
  quote: string;
}

// Named fields, each a list of quote-grounded items. Deliberately NOT eligibility / deadline /
// cost-share (see the header note).
export interface ApplicationRequirements {
  required_sections: RequirementItem[];
  page_format_limits: RequirementItem[];
  required_attachments: RequirementItem[];
  evaluation_criteria: RequirementItem[];
  other_notes: RequirementItem[];
  // Null when at least one field carries an item. Non-null with all fields empty when there is
  // nothing to show, and says which of the three cases it is.
  reason: RequirementsReason | null;
}

// The field keys, in render order. One list so the reader, the writer, and the UI cannot drift on
// which fields exist.
export const REQUIREMENT_FIELDS = [
  "required_sections",
  "page_format_limits",
  "required_attachments",
  "evaluation_criteria",
  "other_notes",
] as const;
export type RequirementField = (typeof REQUIREMENT_FIELDS)[number];

export const EMPTY_REQUIREMENTS: ApplicationRequirements = {
  required_sections: [],
  page_format_limits: [],
  required_attachments: [],
  evaluation_criteria: [],
  other_notes: [],
  reason: null,
};

export interface ApplicationRequirementsGrant {
  id: string;
  title: string | null;
  funder: string | null;
  raw_text?: string | null;
  // The retrievability gate turns on this: 'full' = parsed from the real program NOFO.
  shred_depth?: "full" | "summary" | null;
}

// THE RETRIEVABILITY GATE, as a pure predicate so the page can show the not-retrievable state
// without an LLM call and the generator can refuse to infer -- one definition, both callers.
// Requirements are derived ONLY from a full shred with real NOFO text behind it.
export function requirementsRetrievable(
  grant: Pick<ApplicationRequirementsGrant, "shred_depth" | "raw_text">,
): boolean {
  return grant.shred_depth === "full" && !!(grant.raw_text || "").trim();
}

// ── The quote gate ──────────────────────────────────────────────────────────────────────────
//
// MIRROR of lib/grants/allowable-uses.ts::normalizeForMatch -- the same encoding fold, kept local
// so this brick is self-contained. Both remove only distinctions that live in the ENCODING (soft
// hyphens, hyphenation across a line break, curly quotes, the dash family, whitespace runs), never
// in the writing, so they cannot diverge in meaning. NOT case-folded, on purpose: case is part of
// the text. This is exact containment on the folded forms, not fuzzy matching -- no similarity
// score, no threshold, no partial credit.
function normalizeForMatch(s: string): string {
  return s
    .replace(/[­​‌‍﻿⁠]/g, "")
    .replace(/-[\r\n]+\s*/g, "")
    .replace(/[‘’‚‛′]/g, "'")
    .replace(/[“”„‟″]/g, '"')
    .replace(/[‐‑‒–—―−]/g, "-")
    .replace(/…/g, "...")
    .replace(/[\s ]+/g, " ")
    .trim();
}

function tidyText(s: string): string {
  return s
    .trim()
    .replace(/^[-*•\d.)\s]+/, "")
    .replace(/[\s ]+/g, " ")
    .replace(/\s+$/, "")
    .trim();
}

// Apply the gate to one field's items: shape rules first (so a malformed item is never counted as
// a verification failure), then exact containment on the normalized forms. Returns the survivors
// and how many were dropped, for the audit.
function verifyField(
  haystackNormalized: string,
  items: { text?: unknown; quote?: unknown }[],
  seen: Set<string>,
): { kept: RequirementItem[]; returned: number; dropped: number } {
  const kept: RequirementItem[] = [];
  let dropped = 0;

  for (const item of items.slice(0, MAX_ITEMS_PER_FIELD)) {
    const text = tidyText(String(item?.text ?? ""));
    const quote = String(item?.quote ?? "").trim();
    if (!text || text.split(/\s+/).length > MAX_TEXT_WORDS) continue;
    if (quote.length < MIN_QUOTE_CHARS || quote.length > MAX_QUOTE_CHARS) continue;

    // Dedupe across the WHOLE artifact, not just within a field: the same clause landing in two
    // fields would double-count and read as two requirements.
    const key = text.toLowerCase();
    if (seen.has(key)) continue;

    if (!haystackNormalized.includes(normalizeForMatch(quote))) {
      dropped++;
      continue;
    }
    seen.add(key);
    kept.push({ text, quote });
  }

  return { kept, returned: items.length, dropped };
}

export interface RequirementsVerifyOutcome {
  returned: number;
  kept: number;
  dropped: number;
}

// Verify every field against the full raw_text and return the value to store plus an audit.
export function verifyApplicationRequirements(
  raw: string,
  payload: RawRequirementsPayload,
): { value: ApplicationRequirements; audit: RequirementsVerifyOutcome } {
  const haystack = normalizeForMatch(raw);
  const seen = new Set<string>();
  const value: ApplicationRequirements = { ...EMPTY_REQUIREMENTS, reason: null };
  let returned = 0;
  let kept = 0;
  let dropped = 0;

  for (const field of REQUIREMENT_FIELDS) {
    const raws = Array.isArray(payload[field]) ? (payload[field] as { text?: unknown; quote?: unknown }[]) : [];
    const out = verifyField(haystack, raws, seen);
    value[field] = out.kept;
    returned += out.returned;
    kept += out.kept.length;
    dropped += out.dropped;
  }

  return { value, audit: { returned, kept, dropped } };
}

// ── The excerpt ───────────────────────────────────────────────────────────────────────────────
//
// A contents-page line is not a section. Recognisable by shape rather than wording: short, ending
// in a page number set off by a dot leader or column gap. Same conservative test as allowable-uses.
function looksLikeTocEntry(raw: string, index: number): boolean {
  const from = raw.lastIndexOf("\n", index) + 1;
  const to = raw.indexOf("\n", index);
  const line = raw.slice(from, to === -1 ? raw.length : to).trim();
  if (line.length > 120) return false;
  if (/(?:\.\s?){3,}\s*\d{1,4}$/.test(line)) return true;
  return /(?:\s{2,}|\t)\d{1,4}$/.test(line);
}

function sectionHits(raw: string): number[] {
  const hits: number[] = [];
  for (const re of SECTION_PATTERNS) {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(raw)) !== null) {
      if (!looksLikeTocEntry(raw, m.index)) hits.push(m.index);
      if (m.index === re.lastIndex) re.lastIndex++;
    }
  }
  return hits.sort((a, b) => a - b);
}

// The head (application format/summary lives up front) plus up to two anchored windows on the
// densest requirement-heading clusters (Section IV/V run deep). Verification is against full
// raw_text, so a missed window costs recall only. Windows are joined with a marker so the model
// cannot read across a join as continuous prose.
function requirementSource(raw: string): { excerpt: string; anchored: boolean } {
  const head = raw.slice(0, HEAD_CHARS);
  const hits = sectionHits(raw).filter((h) => h >= HEAD_CHARS); // the head already covers early hits
  if (hits.length === 0) return { excerpt: head, anchored: false };

  const density = (at: number) => hits.filter((h) => Math.abs(h - at) <= WINDOW_CHARS).length;
  const chosen: { start: number; end: number }[] = [];
  const remaining = [...hits];

  while (chosen.length < MAX_ANCHORED_WINDOWS && remaining.length > 0) {
    let best = remaining[0];
    let bestScore = density(best);
    for (const h of remaining) {
      const score = density(h);
      if (score >= bestScore) {
        best = h;
        bestScore = score;
      }
    }
    const start = Math.max(0, best - 500);
    const end = start + WINDOW_CHARS;
    chosen.push({ start, end });
    // Drop every hit this window already covers, so the second window lands somewhere new.
    for (let i = remaining.length - 1; i >= 0; i--) {
      if (remaining[i] >= start && remaining[i] < end) remaining.splice(i, 1);
    }
  }

  chosen.sort((a, b) => a.start - b.start);
  let excerpt = head;
  for (const w of chosen) excerpt += `\n\n[...]\n\n${raw.slice(w.start, w.end)}`;
  return { excerpt, anchored: true };
}

const SYSTEM = `You extract APPLICATION REQUIREMENTS from U.S. federal and state grant notices for GRANTED, a grant-consulting firm.

You are given excerpts of a notice of funding opportunity. Your job is to list what an APPLICATION to this program must contain, and to prove every line by quoting the notice.

Return items under these fields:
- "required_sections": narrative components the application must include (e.g. project narrative, needs statement, work plan, evaluation plan, budget narrative).
- "page_format_limits": page limits, font/margin/spacing rules, file-format rules.
- "required_attachments": forms, letters, certifications, and supporting documents that must be attached (e.g. SF-424, letters of commitment, indirect-cost agreement, audits).
- "evaluation_criteria": the criteria reviewers score the application against, with point weightings if stated.
- "other_notes": any other explicit application requirement that does not fit the fields above.

For each item, return:
- "text": the requirement in plain language, at most ${MAX_TEXT_WORDS} words. No hype, no bullets, no headings, no trailing punctuation.
- "quote": a VERBATIM span copied character-for-character from the excerpt that establishes it. Between ${MIN_QUOTE_CHARS} and ${MAX_QUOTE_CHARS} characters.

Rules, in order of importance:
1. THE QUOTE MUST BE COPIED, NOT RECONSTRUCTED. Do not fix spelling, expand abbreviations, change punctuation, join lines, or tidy spacing. If you cannot copy a span exactly, omit that item entirely. An item without a real quote is worse than a missing item.
2. Every quote must come from the excerpts you were given. Never quote from memory of similar programs.
3. Only list requirements the notice EXPLICITLY states. Do not infer a requirement that "usually" applies.
4. DO NOT return eligibility rules, application deadlines, or match/cost-share requirements. Those are handled separately from verified fields. Listing them here is an error even if the excerpt describes them.
5. At most ${MAX_ITEMS_PER_FIELD} items per field. Prefer distinct, substantive requirements over exhaustive subdivision.
6. Do not name any applicant organization or assess anyone's fit. This list is shown to every client matched to the grant.
7. Set has_requirements to false when the excerpts contain no passage that actually establishes what an application must contain. Returning has_requirements false is a correct and useful answer -- guessing is not.

Call the tool exactly once.`;

export interface RawRequirementsPayload {
  has_requirements?: boolean;
  required_sections?: unknown;
  page_format_limits?: unknown;
  required_attachments?: unknown;
  evaluation_criteria?: unknown;
  other_notes?: unknown;
}

const ITEM_SCHEMA = {
  type: "array",
  items: {
    type: "object",
    properties: { text: { type: "string" }, quote: { type: "string" } },
    required: ["text", "quote"],
  },
} as const;

// Generate and verify. Returns the value to STORE, or null meaning "leave the column alone and
// retry later" -- the same contract as generateAllowableUses. A verified-empty result (including
// the not-retrievable sentinel) is NOT null: it is a real, terminal answer that must not be
// re-asked on every compliance-step open.
export async function generateApplicationRequirements(
  grant: ApplicationRequirementsGrant,
): Promise<{ value: ApplicationRequirements; audit: RequirementsVerifyOutcome | null } | null> {
  // THE HARD RETRIEVABILITY GATE. No full shred / no raw_text -> we cannot reason off the actual
  // NOFO, so we refuse to infer and store the sentinel. Terminal, not retryable.
  if (!requirementsRetrievable(grant)) {
    return { value: { ...EMPTY_REQUIREMENTS, reason: "nofo_not_retrievable" }, audit: null };
  }

  const raw = (grant.raw_text || "").trim();
  const { excerpt, anchored } = requirementSource(raw);

  let payload: RawRequirementsPayload;
  try {
    const client = getAnthropicClient();
    const res = await client.messages.create({
      model: MODEL,
      max_tokens: 3000,
      system: SYSTEM,
      tools: [
        {
          name: "submit_application_requirements",
          description:
            "Return the application requirements, each with a verbatim supporting quote. Call exactly once.",
          input_schema: {
            type: "object",
            properties: {
              has_requirements: {
                type: "boolean",
                description: "True only if the excerpts establish what an application must contain.",
              },
              required_sections: ITEM_SCHEMA,
              page_format_limits: ITEM_SCHEMA,
              required_attachments: ITEM_SCHEMA,
              evaluation_criteria: ITEM_SCHEMA,
              other_notes: ITEM_SCHEMA,
            },
            required: ["has_requirements"],
          },
        },
      ],
      tool_choice: { type: "tool", name: "submit_application_requirements" },
      messages: [
        {
          role: "user",
          content:
            `Grant: ${grant.title ?? "(untitled)"}\nFunder: ${grant.funder ?? "(unknown)"}\n` +
            `Excerpt ${anchored ? "including the application and review sections" : "from the start of the notice"}:\n\n` +
            `${excerpt}\n\nExtract the application requirements now.`,
        },
      ],
    });
    const toolUse = res.content.find((b) => b.type === "tool_use");
    if (!toolUse || toolUse.type !== "tool_use") return null;
    payload = toolUse.input as RawRequirementsPayload;
  } catch {
    // Transient API failure. Retryable -- costs an attempt, writes nothing.
    return null;
  }

  // The model was shown the real NOFO and found no requirements passage. A real answer, stored so
  // it is not re-asked hourly, distinct from a retrieval failure.
  if (payload.has_requirements === false) {
    return { value: { ...EMPTY_REQUIREMENTS, reason: "no_requirements_found" }, audit: null };
  }

  const { value, audit } = verifyApplicationRequirements(raw, payload);

  // MALFORMED, NOT all_dropped, and RETRYABLE. The tool schema requires only has_requirements, so a
  // model can answer has_requirements:true while providing NO item arrays (or non-array junk that
  // verification reads as empty). That is the model failing to fill the tool, not the NOFO lacking
  // requirements -- the exact shape allowable-uses guards with its `!Array.isArray(items)` branch,
  // which returns null (retryable) rather than folding into all_dropped. Caching it as all_dropped
  // would terminally suppress retries on a grant that DOES have requirements. `returned === 0` is
  // the discriminator: nothing structurally valid was provided at all.
  if (audit.returned === 0) {
    console.error(`[requirements] has_requirements=true but no items provided grant=${grant.id}`);
    return null;
  }

  // The model PROVIDED items and not one survived quote verification. Its own reason, terminal:
  // this is the faithfulness signal, distinct from a malformed payload and from no_requirements.
  if (audit.kept === 0) {
    return { value: { ...EMPTY_REQUIREMENTS, reason: "all_dropped" }, audit };
  }

  return { value, audit };
}

// Write a generated result to the grant. Only ever called with a real value (including a
// verified-empty one), so application_requirements_at advances on success only.
export async function saveApplicationRequirements(
  db: SupabaseClient,
  grantId: string,
  value: ApplicationRequirements,
): Promise<void> {
  const { error } = await db
    .from("grants")
    .update({ application_requirements: value, application_requirements_at: new Date().toISOString() })
    .eq("id", grantId);
  if (error) throw new Error(`Failed to save application requirements: ${error.message}`);
}

// Same three-strike shape as allowable-uses. A grant whose text can never yield a verifiable
// artifact costs 3 Anthropic calls total, not one per compliance-step open forever. The route
// consumes an attempt by an atomic compare-and-swap CLAIM before generating (not a post-hoc bump),
// so the ceiling holds even under concurrent opens -- see the claim in the requirements route.
export const MAX_REQUIREMENTS_ATTEMPTS = 3;

// ── Read side ─────────────────────────────────────────────────────────────────────────────────
//
// TOLERANT BY DESIGN, same posture as readAllowableUses. jsonb is schemaless and this column will
// outlive its current shape, so anything unrecognised reads as empty rather than throwing inside a
// page render. An UNAPPLIED 0081 behaves identically to a not-generated column: the select returns
// undefined -> null here -> the page shows requirements-not-generated instead of 500ing.
//
// Returns null when there is NOTHING GENERATED at all (so a caller can distinguish "not derived
// yet" from a stored answer). A stored answer -- even an empty one with a reason -- returns an
// object.
export function readApplicationRequirements(value: unknown): ApplicationRequirements | null {
  if (!value || typeof value !== "object") return null;
  const v = value as Record<string, unknown>;

  const readField = (raw: unknown): RequirementItem[] => {
    if (!Array.isArray(raw)) return [];
    const items: RequirementItem[] = [];
    for (const r of raw) {
      if (!r || typeof r !== "object") continue;
      const { text, quote } = r as { text?: unknown; quote?: unknown };
      if (typeof text !== "string" || !text.trim()) continue;
      items.push({ text: text.trim(), quote: typeof quote === "string" ? quote : "" });
    }
    return items;
  };

  const reason =
    v.reason === "nofo_not_retrievable" || v.reason === "no_requirements_found" || v.reason === "all_dropped"
      ? (v.reason as RequirementsReason)
      : null;

  const result: ApplicationRequirements = {
    required_sections: readField(v.required_sections),
    page_format_limits: readField(v.page_format_limits),
    required_attachments: readField(v.required_attachments),
    evaluation_criteria: readField(v.evaluation_criteria),
    other_notes: readField(v.other_notes),
    reason,
  };

  // A column that is an object but carries neither a known reason nor any item is not a stored
  // answer we can render -- treat it as not-generated so the page offers to derive rather than
  // rendering an empty checklist.
  const hasItems = REQUIREMENT_FIELDS.some((f) => result[f].length > 0);
  if (!hasItems && !reason) return null;
  return result;
}

// True when at least one field carries an item -- i.e. there is a checklist to render, as opposed
// to a sentinel (reason set, all fields empty).
export function hasAnyRequirement(r: ApplicationRequirements): boolean {
  return REQUIREMENT_FIELDS.some((f) => r[f].length > 0);
}

// Client visibility, off unless the value is exactly "true" -- same shape as
// allowableUsesClientVisible(). Read SERVER-SIDE and passed down as a prop, never NEXT_PUBLIC_.
// The whole IntellEngine client surface is already behind PURSUIT_CLIENT_ACCESS_ENABLED; this
// second gate lets STAFF preview the artifact and watch the real drop rate before any client sees
// it -- and this is exactly the surface where a bad extraction would be client-facing.
export function requirementsClientVisible(): boolean {
  return process.env.APPLICATION_REQUIREMENTS_CLIENT_VISIBLE === "true";
}

// Human-readable label for the render order and the empty-field states.
export const REQUIREMENT_FIELD_LABELS: Record<RequirementField, string> = {
  required_sections: "Required narrative sections",
  page_format_limits: "Page & format limits",
  required_attachments: "Required attachments",
  evaluation_criteria: "How reviewers score it",
  other_notes: "Other requirements",
};
