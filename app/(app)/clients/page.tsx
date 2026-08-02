import { requireUser } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { isUnconvertedLead } from "@/lib/leads/stage";
import { deadlineDaysLeft } from "@/lib/report/shape";
import { derivePipeline, type Pipeline, type PipelineCard, type PipelineStageKey } from "@/lib/clients/pipeline";
import { draftProgress } from "@/lib/intellengine/drafts";
import { actionReason, hasEmptyPipeline, rollUpBook } from "@/lib/clients/portfolio";
import { PortfolioBrowser, type PortfolioRow } from "@/components/clients/portfolio-browser";
import type { ClientOverview, IntellEngineDraftStatus } from "@/types/database";

export const dynamic = "force-dynamic";

// The roster surface, built to the approved design (design/portfolio/, the v4 "Ink"
// mockup).
//
// The page's central claim is a SPLIT: clients asking for something today, as large
// cards, above everyone else as a typographic index. The rule behind that split lives
// in lib/clients/portfolio.ts, not here — see it for the thresholds and why "question
// waiting" is wired through at a permanent zero.
//
// Every client's mini bar is the SAME derivePipeline the client dashboard's pipeline
// card uses, and the masthead's book-wide bar is those same five stages summed. That is
// the point: a bar on the roster, the funnel on the detail page, and the strip across
// the top cannot tell different stories, because there is one cascade underneath all
// three. It costs a wider select on review_cards and nothing else.
//
// Dead leads (archived / rejected) are excluded; prospects (un-converted leads) appear
// with a chip. Read-only, staff-only.

type CardRow = PipelineCard & { client_id: string | null; grant_id: string | null };

// How many carded match attempts to pull for the alert-age lookup. Ordered OLDEST
// FIRST, so if the roster ever outgrows this the rows that survive truncation are
// exactly the ones the "oldest sat" figure is about — a truncated read degrades the
// newest ages, which nothing displays, rather than the oldest, which is the whole
// signal.
const ATTEMPT_SCAN_LIMIT = 5000;

export default async function ClientsPage() {
  // Contractors see the roster (it is grant work); "+ Add client" stays admin-only.
  const profile = await requireUser();
  const isAdmin = profile.role === "admin";
  const supabase = createClient();

  const { data: overviewData } = await supabase.from("client_overview").select("*").order("name");
  const clients = ((overviewData ?? []) as ClientOverview[]).filter(
    (c) => c.pipeline_stage !== "archived" && c.pipeline_stage !== "rejected",
  );
  const ids = clients.map((c) => c.id);

  let cards: CardRow[] = [];
  const locById = new Map<string, string>();
  // (client_id | grant_id) -> ms of the first time the engine carded that pair.
  const firstCarded = new Map<string, number>();
  // client_id -> percent complete of that client's furthest-along IntellEngine draft.
  const draftPctById = new Map<string, number>();

  if (ids.length > 0) {
    const [{ data: cardData }, { data: locData }, { data: attemptData }, { data: draftData }] = await Promise.all([
      supabase
        .from("review_cards")
        // Wider than the old rollup by five columns, all of them pipeline inputs or the
        // join key for the age lookup below. No extra round-trip: same query, same
        // filters.
        .select("client_id, grant_id, decision, interested_at, sme_released_at, sent_at, pursuit_path")
        .in("client_id", ids)
        .neq("card_type", "prospect"),
      supabase.from("clients").select("id, location_city, location_state").in("id", ids),
      // WHERE THE ALERT AGE COMES FROM. review_cards has no created_at, so the age of a
      // waiting alert is not recoverable from the card itself — that is why the previous
      // build dropped the design's "oldest sat 41 days" outright. match_attempts does
      // have one, and outcome='carded' is precisely the moment a card came into being,
      // so the first carded attempt for a (client, grant) pair IS when that alert
      // appeared. Filtering on the outcome narrows the engine's full observability log
      // (every pair it ever scored) down to roughly the number of cards that exist.
      supabase
        .from("match_attempts")
        .select("client_id, grant_id, created_at")
        .eq("outcome", "carded")
        .in("client_id", ids)
        .order("created_at", { ascending: true })
        .limit(ATTEMPT_SCAN_LIMIT),
      // Structural step progress on proposals in flight — the design's "Draft 40%".
      // Furthest-along draft per client; see the note on draftPct below for why this is
      // labelled as flow progress and not as narrative written.
      supabase.from("intellengine_drafts").select("client_id, status").in("client_id", ids),
    ]);

    cards = (cardData ?? []) as CardRow[];

    for (const l of (locData ?? []) as { id: string; location_city: string | null; location_state: string | null }[]) {
      // City only, per the design's "Nonprofit · Springdale" subtitle. The state is
      // redundant on a roster that is almost entirely one state, and the card is narrow.
      if (l.location_city) locById.set(l.id, l.location_city);
    }

    // Ascending order means the FIRST row seen for a pair is its earliest attempt, so
    // this is a min without a comparison.
    for (const a of (attemptData ?? []) as { client_id: string | null; grant_id: string | null; created_at: string }[]) {
      if (!a.client_id || !a.grant_id) continue;
      const k = `${a.client_id}|${a.grant_id}`;
      if (firstCarded.has(k)) continue;
      const t = Date.parse(a.created_at);
      if (!Number.isNaN(t)) firstCarded.set(k, t);
    }

    for (const d of (draftData ?? []) as { client_id: string; status: IntellEngineDraftStatus }[]) {
      const pct = draftProgress(d.status).percent;
      const prev = draftPctById.get(d.client_id);
      if (prev === undefined || pct > prev) draftPctById.set(d.client_id, pct);
    }
  }

  const byClient = new Map<string, CardRow[]>();
  for (const c of cards) {
    if (!c.client_id) continue;
    const list = byClient.get(c.client_id);
    if (list) list.push(c);
    else byClient.set(c.client_id, [c]);
  }

  const now = Date.now();
  const pipelines: Pipeline[] = [];

  const rows: PortfolioRow[] = clients.map((c) => {
    const own = byClient.get(c.id) ?? [];
    const pipeline = derivePipeline(own);
    pipelines.push(pipeline);

    // "Alerts" = awaiting review. Identical predicate to /matches and the command
    // band's badge (non-passed, not yet released to the client), so a client's number
    // is the same wherever it is shown.
    const waiting = own.filter((x) => x.decision !== "passed" && x.sme_released_at === null);
    const alerts = waiting.length;

    // How long the longest-waiting of those has been sitting. Null when none of the
    // waiting cards has a carded attempt behind it — manual adds (overridden_at set)
    // never went through the engine, so they legitimately have no first-surfaced time
    // and the card falls back to the plain count rather than guessing one.
    let oldestMs: number | null = null;
    for (const w of waiting) {
      if (!w.grant_id) continue;
      const t = firstCarded.get(`${c.id}|${w.grant_id}`);
      if (t === undefined) continue;
      if (oldestMs === null || t < oldestMs) oldestMs = t;
    }
    const oldestAlertDays = oldestMs === null ? null : Math.floor((now - oldestMs) / 86_400_000);

    const deadlineDays = deadlineDaysLeft(c.next_deadline);
    // See lib/clients/portfolio.ts: no question store exists, so this is a real zero
    // rather than a placeholder. The reason stays wired for when one does.
    const questions = 0;

    const counts = {} as Record<PipelineStageKey, number>;
    for (const s of pipeline.stages) counts[s.key] = s.count;

    return {
      id: c.id,
      name: c.name,
      subtitle: [c.org_type?.replace(/_/g, " "), locById.get(c.id)].filter(Boolean).join(" · ") || "—",
      isProspect: isUnconvertedLead(c.pipeline_stage),
      alerts,
      oldestAlertDays,
      deadlineDays,
      deadlineDate: c.next_deadline,
      questions,
      // Step progress on the furthest-along proposal, or null if this client has none
      // in flight. Deliberately NOT a claim about how much narrative is drafted — it is
      // the rung on the scope -> compliance -> build ladder, the same figure the client
      // dashboard shows, and the card says "of the flow" so it cannot be misread.
      draftPct: draftPctById.get(c.id) ?? null,
      reason: actionReason({ alerts, deadlineDays, questions }),
      counts,
      totalGrants: pipeline.total,
      inPursuit: counts.pursuit ?? 0,
      emptyPipeline: hasEmptyPipeline(pipeline),
    };
  });

  const book = rollUpBook(pipelines);
  // Soonest deadline anywhere in the book, for the masthead figure. Past-due dates are
  // excluded rather than shown as a negative: the tile answers "how long until the next
  // thing is due", and an overdue grant is a different statement that the client's own
  // card already makes.
  const nextDeadlineDays = rows
    .map((r) => r.deadlineDays)
    .filter((d): d is number => d !== null && d >= 0)
    .reduce<number | null>((min, d) => (min === null || d < min ? d : min), null);

  return (
    <PortfolioBrowser
      rows={rows}
      isAdmin={isAdmin}
      book={book}
      nextDeadlineDays={nextDeadlineDays}
      today={new Date().toISOString()}
    />
  );
}
