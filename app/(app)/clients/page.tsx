import { requireUser } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { isUnconvertedLead } from "@/lib/leads/stage";
import { deadlineDaysLeft } from "@/lib/report/shape";
import { derivePipeline, type PipelineCard, type PipelineStageKey } from "@/lib/clients/pipeline";
import { actionReason, hasEmptyPipeline } from "@/lib/clients/portfolio";
import { PortfolioBrowser, type PortfolioRow } from "@/components/clients/portfolio-browser";
import type { ClientOverview } from "@/types/database";

export const dynamic = "force-dynamic";

// The roster surface, built to the approved design (design/portfolio/).
//
// The page's central claim is a SPLIT: clients asking for something today, as large
// cards, above everything else as a quieter grid. The rule behind that split lives in
// lib/clients/portfolio.ts, not here — see it for the thresholds and why "question
// waiting" is wired through at a permanent zero.
//
// Every client's mini bar is the SAME derivePipeline the client dashboard's pipeline
// card uses. That is the point: a bar on the roster and the funnel on the detail page
// are the same five stages derived by the same cascade, so they cannot tell different
// stories about one client. It costs a wider select on review_cards and nothing else.
//
// Dead leads (archived / rejected) are excluded; prospects (un-converted leads) appear
// with a chip. Read-only, staff-only.

type CardRow = PipelineCard & { client_id: string | null };

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
  if (ids.length > 0) {
    const [{ data: cardData }, { data: locData }] = await Promise.all([
      supabase
        .from("review_cards")
        // Wider than the old rollup by four columns, all of them pipeline inputs. No
        // extra round-trip: same query, same filters.
        .select("client_id, decision, interested_at, sme_released_at, sent_at, pursuit_path")
        .in("client_id", ids)
        .neq("card_type", "prospect"),
      supabase.from("clients").select("id, location_city, location_state").in("id", ids),
    ]);
    cards = (cardData ?? []) as CardRow[];
    for (const l of (locData ?? []) as { id: string; location_city: string | null; location_state: string | null }[]) {
      // City only, per the design's "Nonprofit · Springdale" subtitle. The state is
      // redundant on a roster that is almost entirely one state, and the card is narrow.
      if (l.location_city) locById.set(l.id, l.location_city);
    }
  }

  const byClient = new Map<string, CardRow[]>();
  for (const c of cards) {
    if (!c.client_id) continue;
    const list = byClient.get(c.client_id);
    if (list) list.push(c);
    else byClient.set(c.client_id, [c]);
  }

  const rows: PortfolioRow[] = clients.map((c) => {
    const own = byClient.get(c.id) ?? [];
    const pipeline = derivePipeline(own);
    // "Alerts" = awaiting review. Identical predicate to /matches and the command
    // band's badge (non-passed, not yet released to the client), so a client's number
    // is the same wherever it is shown.
    const alerts = own.filter((x) => x.decision !== "passed" && x.sme_released_at === null).length;
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
      deadlineDays,
      deadlineDate: c.next_deadline,
      questions,
      reason: actionReason({ alerts, deadlineDays, questions }),
      counts,
      totalGrants: pipeline.total,
      inPursuit: counts.pursuit ?? 0,
      emptyPipeline: hasEmptyPipeline(pipeline),
    };
  });

  return <PortfolioBrowser rows={rows} isAdmin={isAdmin} />;
}
