import type { SupabaseClient } from "@supabase/supabase-js";
import { getAnthropicClient, MODEL } from "@/lib/anthropic";

// THE ONE GRANT DESCRIPTION every human-facing surface reads (migration 0069).
//
// Generated ONCE per grant and cached on grants.description_brief, then reused by the
// console detail, the portal detail, and the alert PDF hero. Before this, each surface
// improvised: the detail pages printed grants.description (the agency's own prose, often
// a single clipped line) and the PDF hero built from review_cards.description_short --
// which the matcher writes CLIENT-SLANTED, so it read as a second concept proposal
// stacked on top of the real one.
//
// GRANT-LEVEL, NEVER CLIENT-LEVEL. One row serves every client matched to the grant, so
// the copy must not name an applicant, assert a fit, or propose a role. That read already
// exists per-card (concept_synopsis / why_this_org) and the prompt below forbids it here.
//
// ENRICHMENT ONLY. Nothing in the occupancy/seat scorer reads this column, so a brief --
// good, bad, or absent -- cannot move a fit score. Generation deliberately does NOT live
// in the ingest path: app/api/cron/ingest/route.ts and lib/grants/pipeline.ts are
// protected files, so the corpus fills in via /api/cron/grant-briefs plus the
// ensureGrantBrief call on the alert draft path.

// ~250 words, per Shannon's spec for the detail pages. Enforced in WORDS (the unit the
// spec is in) and cut on a sentence boundary, so a brief never ends mid-thought.
const MAX_WORDS = 250;
// Below this there is nothing to paraphrase -- a title-only husk would make the model
// invent a program. Those grants keep falling back to whatever description they have.
const MIN_SOURCE_CHARS = 120;
// How much raw_text to hand the model when `description` alone is too thin. raw_text holds
// up to 100k chars of the published NOFO (pipeline.ts), which is far more than this job
// needs -- the shape of the program is established in the opening pages, and the concept
// builder already reads an excerpt for the same reason (lib/concept/schema.ts).
const RAW_EXCERPT_CHARS = 8000;
// A generated brief under this is a stub, not a description, and must not be cached: the
// whole point of the column is that it says more than the agency's clipped one-liner.
// Rejecting returns null, which leaves description_brief_at unadvanced and retries on the
// next sweep. Was 20 -- high enough to catch an echoed title, too low to catch a brief
// that technically parses but tells a reader nothing.
const MIN_BRIEF_WORDS = 45;

const SYSTEM = `You write plain-language program descriptions for GRANTED, a U.S. grant-consulting firm.

Given a grant's own published text, write ONE description of what the program funds, in this shape:
funding provided to [who receives it] for [what purpose] by doing [what activities the money pays for].

Rules:
- Follow that shape in substance, not as a fill-in-the-blank template. Write real prose in complete sentences.
- Between 120 and 200 words. ${MAX_WORDS} is a hard maximum, and anything under 60 words is too short to be useful -- a reader who sees only your description must come away understanding what the program pays for.
- Do NOT state dollar amounts, award ranges, deadlines, dates, match/cost-share percentages, or the number of awards. Those are rendered separately from verified fields, and a number written here would be a second, unverified copy.
- Do NOT name any specific applicant organization, assess anyone's fit, or recommend a role (prime, sub, partner). This description is shown to every client matched to the grant.
- Do NOT restate eligibility rules; a separate section covers who can apply. One clause on the general class of recipient ("community health centers", "county governments") is fine.
- Plain, direct language. No hype, no marketing tone, no em-dashes, no bullet points, no headings.
- Stay strictly faithful to the provided text. If the text is thin, write a shorter description rather than filling the gap with plausible detail.
- U.S. domestic framing.

Return ONLY the description text. No preamble, no quotes, no JSON.`;

export interface BriefableGrant {
  id: string;
  title: string | null;
  funder: string | null;
  description: string | null;
  // The published NOFO text. Read only when `description` is too thin to paraphrase --
  // see briefSource.
  raw_text?: string | null;
  focus_areas: string[] | null;
  program_type: string | null;
}

// Trim to MAX_WORDS on a sentence boundary. Falls back to a hard word cut with an
// ellipsis only when the first sentence alone overruns.
function clampWords(s: string, max: number): string {
  const t = s.trim();
  const words = t.split(/\s+/);
  if (words.length <= max) return t;
  const head = words.slice(0, max).join(" ");
  const m = head.match(/^[\s\S]*[.!?](?=\s|$)/);
  if (m && m[0].trim().split(/\s+/).length >= 40) return m[0].trim();
  return head.replace(/[,;:]$/, "") + "…";
}

// Strip the things the model is told not to do but occasionally does anyway: a code fence,
// a "Description:"-style lead-in, wrapping quotes, and markdown list/heading markers.
//
// ORDER MATTERS in two places, both of which shipped wrong first:
//   - the label comes off BEFORE the quotes. `Description: "Funding provided to..."` hides
//     the opening quote behind the label, so stripping quotes first leaves it orphaned.
//   - the final collapse is /\s+/, not /[ \t]+/. Removing a bullet from `- a\n\n- b` leaves
//     a lone newline that a blank-line-only collapse walks straight past.
function tidy(raw: string): string {
  const unwrapped = raw
    .trim()
    .replace(/^```[a-z]*\n?|\n?```$/g, "")
    .replace(/^\s*[-*•#]+[ \t]*/gm, "")
    // A label ends with a colon ("Description: ...") or is its own line ("## Summary\n..."),
    // and the marker strip above has already taken the ## off. Runs BEFORE the whitespace
    // collapse, which is the only point where that newline still exists to anchor on.
    .replace(/^(?:description|summary|brief|overview)[ \t]*[:\n][ \t]*/i, "")
    // A brief is one prose block by definition, so every whitespace run is a single space.
    .replace(/\s+/g, " ")
    .trim();
  return unwrapped.replace(/^["'“”]+|["'“”]+$/g, "").trim();
}

// WHAT THE MODEL IS ALLOWED TO READ, and why it is not just `description`.
//
// THIS IS THE BUG BEHIND "the description is about ten words". `description` is often the
// agency's own clipped one-liner -- under MIN_SOURCE_CHARS -- so generation returned null,
// nothing was ever written, and every reader fell back to that same one-liner. Permanently:
// the sweep re-picked the grant, re-measured the same short string, and skipped it again.
// The fallback was working exactly as designed and hiding a grant that could never
// generate. (Those are the "skipped" in the sweep's log line.)
//
// raw_text is the published NOFO itself, stored by the ingest pipeline. Reading an excerpt
// of it is not a licence to invent: it is MORE of the grant's own words, which is what the
// prompt's faithfulness rule asks for. Appended rather than substituted, because when
// `description` is a real paragraph it is the cleaner, already-summarised source and should
// still lead.
//
// raw_text is API JSON rather than prose for some grants (see backfill-entity-types). That
// is left as-is deliberately: it is still the grant's own published field values, the model
// reads it as context, and pre-parsing every shape it might take would be a second shredder.
function briefSource(grant: BriefableGrant): string {
  const description = (grant.description || "").trim();
  if (description.length >= MIN_SOURCE_CHARS) return description;

  const raw = (grant.raw_text || "").trim();
  if (!raw) return description;
  const excerpt = raw.slice(0, RAW_EXCERPT_CHARS);
  return description ? `${description}\n\n${excerpt}` : excerpt;
}

// Generate the paraphrase. Returns null on any failure or an unusable result -- the
// caller must treat null as "leave the column alone and retry later", never as "write
// an empty brief".
export async function generateGrantBrief(grant: BriefableGrant): Promise<string | null> {
  const source = briefSource(grant);
  if (source.length < MIN_SOURCE_CHARS) return null;

  try {
    const client = getAnthropicClient();
    const res = await client.messages.create({
      model: MODEL,
      max_tokens: 700,
      system: SYSTEM,
      messages: [
        {
          role: "user",
          content: `Grant text (read-only):\n${JSON.stringify(
            {
              title: grant.title,
              funder: grant.funder,
              description: source,
              focus_areas: grant.focus_areas,
              program_type: grant.program_type,
            },
            null,
            2,
          )}\n\nWrite the description now.`,
        },
      ],
    });
    const text = tidy(
      res.content
        .filter((b) => b.type === "text")
        .map((b) => (b as { text: string }).text)
        .join(""),
    );
    // A stub means the model refused, echoed the title, or had too little to work with --
    // none of which is worth caching over a retry. See MIN_BRIEF_WORDS.
    if (text.split(/\s+/).length < MIN_BRIEF_WORDS) return null;
    return clampWords(text, MAX_WORDS);
  } catch {
    return null;
  }
}

// Write a generated brief. Only ever called with a non-null brief, so
// description_brief_at advances on success only and a failure retries next sweep.
async function saveBrief(db: SupabaseClient, grantId: string, brief: string): Promise<void> {
  const { error } = await db
    .from("grants")
    .update({ description_brief: brief, description_brief_at: new Date().toISOString() })
    .eq("id", grantId);
  if (error) throw new Error(`Failed to save grant brief: ${error.message}`);
}

// Read-through cache for the ONE place that cannot wait for the hourly sweep: the alert
// draft. A grant ingested minutes ago may not have a brief yet, and the alert is the
// artifact a client actually reads, so this generates inline and caches the result.
//
// Returns the brief to use, or null when there is none and the caller should fall back to
// grants.description. NEVER throws -- an alert must still render if this fails.
export async function ensureGrantBrief(
  db: SupabaseClient,
  grant: BriefableGrant & { description_brief?: string | null },
): Promise<string | null> {
  const existing = (grant.description_brief || "").trim();
  if (existing) return existing;
  try {
    const brief = await generateGrantBrief(grant);
    if (!brief) return null;
    await saveBrief(db, grant.id, brief);
    return brief;
  } catch (e) {
    console.error(`[grant-brief] inline generation failed grant=${grant.id}:`, e instanceof Error ? e.message : e);
    return null;
  }
}

// raw_text is here because briefSource falls back to it when `description` is too thin --
// which was the whole reason grants with a clipped one-line description could never
// generate a brief. It is the largest column on the table (up to 100k chars), so the sweep
// pays for it per claimed row; at PER_RUN_CAP=25 that is a bounded cost, and skipping the
// grants that need it most is the alternative.
const SELECT = "id, title, funder, description, raw_text, focus_areas, program_type";

export interface BriefSweepResult {
  written: number;
  skipped: number;
  processed: number;
  more: boolean;
}

// Bounded backfill sweep. Claims the oldest grants with no brief, generates in small
// batches, and writes only real results. Idempotent: a written grant never reappears, and
// a skipped one (generation failed, or too little source text to paraphrase) is retried
// on the next run at no risk -- the retry is the whole reason description_brief_at is not
// advanced on failure.
export async function sweepGrantBriefs(
  db: SupabaseClient,
  opts: { cap: number; batchSize?: number },
): Promise<BriefSweepResult> {
  const batchSize = opts.batchSize ?? 5;
  const { data, error } = await db
    .from("grants")
    .select(SELECT)
    .is("description_brief", null)
    .order("ingested_at", { ascending: true })
    .limit(opts.cap);

  if (error) throw new Error(`Brief sweep query failed: ${error.message}`);

  const pending = (data ?? []) as BriefableGrant[];
  let written = 0;
  let skipped = 0;

  for (let i = 0; i < pending.length; i += batchSize) {
    const batch = pending.slice(i, i + batchSize);
    const results = await Promise.allSettled(
      batch.map(async (g) => {
        const brief = await generateGrantBrief(g);
        if (!brief) return false;
        await saveBrief(db, g.id, brief);
        return true;
      }),
    );
    for (const r of results) {
      if (r.status === "fulfilled" && r.value) written++;
      else skipped++;
    }
  }

  return { written, skipped, processed: pending.length, more: pending.length === opts.cap };
}
