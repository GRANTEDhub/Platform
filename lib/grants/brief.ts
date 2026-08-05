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
const SELECT =
  "id, title, funder, description, raw_text, focus_areas, program_type, description_brief_attempts";

// The sweep needs the attempt count; the shared BriefableGrant does not (ensureGrantBrief's
// callers pass a grant row that has no reason to carry it), so it rides as a local shape
// rather than widening the interface.
type SweepRow = BriefableGrant & { description_brief_attempts: number | null };

// ATTEMPTS BEFORE A ROW IS PARKED. Three is enough to ride out a transient Anthropic error
// and low enough that a permanently un-generatable grant costs 3 calls in total instead of
// one an hour forever.
//
// DUPLICATED IN THE INDEX PREDICATE (migration 0071). A partial index cannot reference
// application config, so raising this REQUIRES a new migration widening
// grants_description_brief_pending_idx to match -- otherwise the planner scans every
// unwritten row, including the parked ones this exists to stop touching.
const MAX_BRIEF_ATTEMPTS = 3;

// Record a failed attempt. Read-then-write rather than an atomic increment: the sweep is
// hourly with maxDuration 300s, so it never overlaps itself, and a lost increment would
// only mean one extra retry rather than anything incorrect.
//
// NEVER THROWS. A failed bump must not turn one grant's skip into the whole run's failure;
// the worst case is the row is retried once more next hour, which is the old behaviour.
async function recordFailedAttempt(db: SupabaseClient, grantId: string, current: number | null): Promise<void> {
  const { error } = await db
    .from("grants")
    .update({ description_brief_attempts: (current ?? 0) + 1 })
    .eq("id", grantId);
  if (error) console.error(`[grant-brief] attempt bump failed grant=${grantId}: ${error.message}`);
}

// How many rows the cap has taken out of the claim window entirely. Logged so this is a
// number someone can read, rather than something inferred from a skip-rate trend across
// hours -- which is how the looping went unnoticed in the first place.
//
// NULL RATHER THAN A THROW. This runs AFTER every write in the sweep has committed, so
// throwing here would turn a fully successful run into a reported 500 and -- worse -- make
// the route log an error instead of the counts. A diagnostic must never be able to fail the
// work it is describing. Null prints as "?", which is honest: the number is unknown, not
// zero.
//
// Deliberately unindexed. The predicate is the complement of the claim index
// (attempts >= MAX rather than < MAX), so it scans the null-brief rows -- a few hundred on a
// 958-row table, once an hour. An index existing only to serve a log line is the wrong
// trade; revisit if grants grows an order of magnitude.
async function countParked(db: SupabaseClient): Promise<number | null> {
  const { count, error } = await db
    .from("grants")
    .select("id", { count: "exact", head: true })
    .is("description_brief", null)
    .gte("description_brief_attempts", MAX_BRIEF_ATTEMPTS);
  if (error) {
    console.error(`[grant-brief] parked count failed: ${error.message}`);
    return null;
  }
  return count ?? 0;
}

export interface BriefSweepResult {
  written: number;
  skipped: number;
  processed: number;
  more: boolean;
  // Rows the attempt cap has removed from the claim window for good. Null when the count
  // query itself failed -- unknown, not zero.
  parked: number | null;
  // Phase 2 (the one-time re-do of briefs written before the raw_text fallback). All three
  // go to zero permanently once the pre-cutoff window is drained.
  regenerated: number;
  // SPLIT, because a single `retired` count could not answer the only question that
  // mattered about the backfill: the first production run reported `regenerated 0,
  // retired 5` and there was no way to tell whether those 5 briefs were already long
  // enough (nothing to fix) or had failed to regenerate (something to fix).
  retiredCurrent: number; // already clears the stub floor -- stamped, never regenerated
  retiredFailed: number;  // regeneration returned nothing -- keeps its existing brief
}

// PHASE 2 CUTOFF -- the moment the raw_text fallback reached production (#308, deploy
// 20:11 UTC 2026-08-04; the first sweep on the new code was 20:37). Every brief stamped
// before this was generated from `description` alone and judged against the old 20-word
// stub floor, so the thin ones are worth one re-try against the better source. Briefs
// stamped after it are already current and are never claimed here.
//
// A CONSTANT, NOT A ROLLING WINDOW, so this is genuinely one-time: every row it claims
// leaves the window in the same run (regenerated, or retired below), so the phase-2
// backlog only ever shrinks and the whole phase costs nothing once empty.
const THIN_BRIEF_CUTOFF = "2026-08-04T20:20:00Z";

// RESERVED CAPACITY for phase 2, so the backfill cannot starve behind phase 1.
//
// The first version gave phase 1 strict priority: phase 2 spent only `cap - claimed`, which
// is ZERO on any run where the null-brief backlog still fills the cap. With `more=true` run
// after run that meant the re-do would not begin until the entire corpus had a brief -- an
// unbounded wait, and it left the terminate path below completely unexercised. Reserving a
// few slots keeps the priority ordering (20 of 25 still go to grants with NO brief, which is
// the worse failure) while letting the thin backlog drain in hours instead of never.
//
// Reserved ONLY when there is something to reserve for -- see the probe. Once the pre-cutoff
// window is empty, phase 1 goes back to the full cap rather than idling 5 slots forever.
const PHASE2_FLOOR = 5;

// Cheap existence probe: head-only count, no rows and no raw_text, so it costs a single
// index-less count over a few hundred rows rather than a hydrate.
async function countThinCandidates(db: SupabaseClient): Promise<number> {
  const { count, error } = await db
    .from("grants")
    .select("id", { count: "exact", head: true })
    .not("description_brief", "is", null)
    .lt("description_brief_at", THIN_BRIEF_CUTOFF);
  if (error) throw new Error(`Thin-brief probe failed: ${error.message}`);
  return count ?? 0;
}

// Re-do briefs that predate the cutoff AND fall under the current stub floor.
//
// RETIRING IS AS IMPORTANT AS REGENERATING. Anything claimed here is stamped -- either
// with a new brief, or (when it is already long enough, or regeneration fails) by simply
// advancing description_brief_at while keeping the brief it has. Without that, a grant
// whose text cannot produce 45 words would be re-claimed every hour forever, and this
// phase would never stop costing an Anthropic call. The row keeps its existing brief
// either way, so a failure here is never worse than the status quo.
async function requeueThinBriefs(
  db: SupabaseClient,
  budget: number,
  batchSize: number,
): Promise<{ regenerated: number; retiredCurrent: number; retiredFailed: number }> {
  if (budget <= 0) return { regenerated: 0, retiredCurrent: 0, retiredFailed: 0 };

  // Light query first -- no raw_text, which is the expensive column. Only the rows that
  // turn out to be thin pay for the full select below.
  const { data, error } = await db
    .from("grants")
    .select("id, description_brief")
    .not("description_brief", "is", null)
    .lt("description_brief_at", THIN_BRIEF_CUTOFF)
    .order("description_brief_at", { ascending: true })
    .limit(budget);
  if (error) throw new Error(`Thin-brief claim failed: ${error.message}`);

  const claimed = (data ?? []) as { id: string; description_brief: string | null }[];
  if (claimed.length === 0) return { regenerated: 0, retiredCurrent: 0, retiredFailed: 0 };

  const wordCount = (s: string) => s.trim().split(/\s+/).filter(Boolean).length;
  const thin = claimed.filter((r) => wordCount(r.description_brief || "") < MIN_BRIEF_WORDS);
  const alreadyFine = claimed.filter((r) => !thin.includes(r));

  const stamp = new Date().toISOString();
  let retiredCurrent = 0;
  let retiredFailed = 0;

  // Bulk-retire the ones that are already long enough: nothing to regenerate, they just
  // need to leave the window.
  if (alreadyFine.length > 0) {
    const { error: retireErr } = await db
      .from("grants")
      .update({ description_brief_at: stamp })
      .in("id", alreadyFine.map((r) => r.id));
    if (retireErr) throw new Error(`Thin-brief retire failed: ${retireErr.message}`);
    retiredCurrent += alreadyFine.length;
  }

  if (thin.length === 0) return { regenerated: 0, retiredCurrent, retiredFailed };

  const { data: full, error: fullErr } = await db
    .from("grants")
    .select(SELECT)
    .in("id", thin.map((r) => r.id));
  if (fullErr) throw new Error(`Thin-brief hydrate failed: ${fullErr.message}`);

  const rows = (full ?? []) as BriefableGrant[];
  let regenerated = 0;

  for (let i = 0; i < rows.length; i += batchSize) {
    const batch = rows.slice(i, i + batchSize);
    const results = await Promise.allSettled(
      batch.map(async (g) => {
        const brief = await generateGrantBrief(g);
        if (brief) {
          await saveBrief(db, g.id, brief);
          return true;
        }
        // Keep the old brief, but stamp it so this row leaves the window for good.
        await db.from("grants").update({ description_brief_at: stamp }).eq("id", g.id);
        return false;
      }),
    );
    for (const r of results) {
      if (r.status === "fulfilled" && r.value) regenerated++;
      else retiredFailed++;
    }
  }

  return { regenerated, retiredCurrent, retiredFailed };
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

  // Probe BEFORE claiming, because the answer changes phase 1's claim size. Total work per
  // run still never exceeds opts.cap, so maxDuration is unaffected either way.
  const thinWaiting = await countThinCandidates(db);
  // opts.cap - 1 floor so phase 1 always keeps at least one slot: a .limit(0) is not
  // dependably "no rows" and would be a silent full-table claim. Unreachable at
  // PER_RUN_CAP=25, but this function should not depend on its caller's constant.
  const reserved = thinWaiting > 0 ? Math.min(PHASE2_FLOOR, thinWaiting, Math.max(opts.cap - 1, 0)) : 0;
  const phase1Cap = opts.cap - reserved;

  const { data, error } = await db
    .from("grants")
    .select(SELECT)
    .is("description_brief", null)
    .lt("description_brief_attempts", MAX_BRIEF_ATTEMPTS)
    .order("ingested_at", { ascending: true })
    .limit(phase1Cap);

  if (error) throw new Error(`Brief sweep query failed: ${error.message}`);

  const pending = (data ?? []) as SweepRow[];
  let written = 0;
  let skipped = 0;

  for (let i = 0; i < pending.length; i += batchSize) {
    const batch = pending.slice(i, i + batchSize);
    const results = await Promise.allSettled(
      batch.map(async (g) => {
        // The try wraps GENERATION ONLY. A throw here is the same outcome as a null as far
        // as this row is concerned -- no brief -- so it costs an attempt. A saveBrief
        // failure below is deliberately NOT caught: the brief was produced, so a write
        // error is a real fault worth surfacing, not a spent attempt.
        let brief: string | null = null;
        try {
          brief = await generateGrantBrief(g);
        } catch (e) {
          console.error(`[grant-brief] generation threw grant=${g.id}:`, e instanceof Error ? e.message : e);
        }
        if (!brief) {
          await recordFailedAttempt(db, g.id, g.description_brief_attempts);
          return false;
        }
        try {
          await saveBrief(db, g.id, brief);
        } catch (e) {
          // Logged rather than swallowed into the skip count. The comment above says a write
          // error is "a real fault worth surfacing" -- but nothing surfaced it: the rejection
          // just incremented `skipped`, indistinguishable from a grant with nothing to
          // paraphrase. Still costs no attempt (the brief WAS produced), so it retries next
          // hour, which is correct for a transient write failure.
          console.error(`[grant-brief] save failed grant=${g.id}:`, e instanceof Error ? e.message : e);
          return false;
        }
        return true;
      }),
    );
    for (const r of results) {
      if (r.status === "fulfilled" && r.value) written++;
      else skipped++;
    }
  }

  // Unwritten briefs still come first -- a grant with NO brief shows the raw agency
  // one-liner, which is the worse of the two failures -- but phase 2 gets at least its
  // reserved slots, plus whatever phase 1 left unused on a light run.
  const { regenerated, retiredCurrent, retiredFailed } = await requeueThinBriefs(
    db,
    Math.max(opts.cap - pending.length, reserved),
    batchSize,
  );

  return {
    written,
    skipped,
    parked: await countParked(db),
    processed: pending.length,
    // AGAINST phase1Cap, NOT opts.cap. Reserving slots shrinks the claim, so comparing to
    // the full cap would read a saturated run (20 of 20) as "nothing left" and stall the
    // drain silently -- the same shape of bug as the cache-stalled queue in July.
    more: pending.length === phase1Cap && phase1Cap > 0,
    regenerated,
    retiredCurrent,
    retiredFailed,
  };
}
