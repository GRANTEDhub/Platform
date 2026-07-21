import Link from "next/link";
import { differenceInCalendarDays, format, parseISO } from "date-fns";
import { Building2, CheckCircle2, ClipboardList, CalendarClock } from "lucide-react";
import { requireAdmin } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { PageHeader } from "@/components/layout/page-header";
import { Stat } from "@/components/ui/stat";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { NON_LEAD_OR_FILTER } from "@/lib/leads/stage";
import type { ClientOverview, CardDecision } from "@/types/database";

export const dynamic = "force-dynamic";

// The portfolio cockpit: every active client on one screen, as cards, rolled up
// by their LIVE grant pipeline (approved = active opportunities, pending = in
// review) plus average fit and next deadline. A card-based counterpart to the
// dense billing-focused /dashboard table. Everything here is a real count from
// review_cards -- no dollar figures (funding is free-text on grants, so a summed
// "pipeline value" would be false precision) and no health signal we don't track.
// Read-only, staff-only; the client-facing view is a later pass.

function statusVariant(status: string) {
  switch (status) {
    case "active":
      return "success" as const;
    case "prospect":
      return "default" as const;
    case "paused":
      return "warning" as const;
    default:
      return "secondary" as const;
  }
}

// Deadline with an urgency tell, mirroring the dashboard's DeadlineCell (≤14d is
// hot). next_deadline is already the soonest approved-match deadline (computed in
// the client_overview view), so this is a pure format.
function deadlineDisplay(date: string | null): { text: string; urgent: boolean } {
  if (!date) return { text: "—", urgent: false };
  const days = differenceInCalendarDays(parseISO(date), new Date());
  return { text: `${format(parseISO(date), "MMM d")} · ${days}d`, urgent: days <= 14 };
}

type Rollup = { active: number; inReview: number; fitSum: number; fitCount: number };
const EMPTY_ROLLUP: Rollup = { active: 0, inReview: 0, fitSum: 0, fitCount: 0 };

export default async function PortfolioPage() {
  await requireAdmin();
  const supabase = createClient();

  // Roster from client_overview (excludes leads via the shared predicate) -- gives
  // name/org_type/status/next_deadline without a second clients query.
  const { data: overviewData } = await supabase
    .from("client_overview")
    .select("*")
    .or(NON_LEAD_OR_FILTER)
    .order("name");
  const clients = (overviewData ?? []) as ClientOverview[];

  // Per-client match rollups in ONE fetch, aggregated in code (same shape as the
  // client-first gate). CLIENT cards only -- prospect cards (Track 2) never count.
  const ids = clients.map((c) => c.id);
  type CardRow = {
    client_id: string | null;
    card_type: string | null;
    decision: CardDecision;
    fit_score: number | null;
  };
  let cards: CardRow[] = [];
  if (ids.length > 0) {
    const { data: cardData } = await supabase
      .from("review_cards")
      .select("client_id, card_type, decision, fit_score")
      .in("client_id", ids)
      .neq("card_type", "prospect");
    cards = (cardData ?? []) as CardRow[];
  }

  const byClient = new Map<string, Rollup>();
  for (const c of cards) {
    if (!c.client_id) continue;
    const r = byClient.get(c.client_id) ?? { ...EMPTY_ROLLUP };
    if (c.decision === "approved") r.active += 1;
    else if (c.decision === "pending") r.inReview += 1;
    // Avg fit reflects the LIVE pipeline (approved + pending); passed matches were
    // rejected and shouldn't drag the average of what's actually in play.
    if ((c.decision === "approved" || c.decision === "pending") && typeof c.fit_score === "number") {
      r.fitSum += c.fit_score;
      r.fitCount += 1;
    }
    byClient.set(c.client_id, r);
  }

  // Busiest first (most active opportunities), then alphabetical.
  const rows = clients
    .map((c) => ({ c, r: byClient.get(c.id) ?? EMPTY_ROLLUP }))
    .sort((a, b) => b.r.active - a.r.active || a.c.name.localeCompare(b.c.name));

  const totalActive = rows.reduce((s, { r }) => s + r.active, 0);
  const totalInReview = rows.reduce((s, { r }) => s + r.inReview, 0);
  const deadlineSoon = clients.filter(
    (c) => c.next_deadline && differenceInCalendarDays(parseISO(c.next_deadline), new Date()) <= 30,
  ).length;

  return (
    <div>
      <PageHeader
        title="Portfolio"
        description="Every client's live grant pipeline at a glance."
      />

      <div className="space-y-6 p-8">
        <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
          <Stat
            label="Clients"
            value={String(clients.length)}
            icon={<Building2 className="h-4 w-4" />}
          />
          <Stat
            label="Active opportunities"
            value={String(totalActive)}
            hint="approved matches"
            icon={<CheckCircle2 className="h-4 w-4" />}
          />
          <Stat
            label="In review"
            value={String(totalInReview)}
            hint="pending matches"
            icon={<ClipboardList className="h-4 w-4" />}
          />
          <Stat
            label="Deadlines ≤30d"
            value={String(deadlineSoon)}
            accent
            icon={<CalendarClock className="h-4 w-4" />}
          />
        </div>

        {rows.length === 0 ? (
          <Card className="p-12 text-center text-muted-foreground">
            No clients yet. Add your first client to get started.
          </Card>
        ) : (
          <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
            {rows.map(({ c, r }) => {
              const dl = deadlineDisplay(c.next_deadline);
              const avgFit = r.fitCount > 0 ? `${(r.fitSum / r.fitCount).toFixed(1)}/3` : "—";
              return (
                <Link key={c.id} href={`/clients/${c.id}`} className="group block">
                  <Card className="p-6 transition-shadow group-hover:shadow-lift">
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <h3 className="truncate font-serif text-lg font-semibold text-brand-navy">
                          {c.name}
                        </h3>
                        <p className="mt-0.5 truncate text-sm capitalize text-muted-foreground">
                          {c.org_type?.replace(/_/g, " ") || "—"}
                        </p>
                      </div>
                      <Badge variant={statusVariant(c.status)}>{c.status}</Badge>
                    </div>

                    <div className="mt-5 grid grid-cols-2 gap-4 border-t border-brand-navy/5 pt-4">
                      <Metric label="Active" value={String(r.active)} />
                      <Metric label="In review" value={String(r.inReview)} />
                      <Metric label="Avg fit" value={avgFit} />
                      <Metric label="Next deadline" value={dl.text} accent={dl.urgent} />
                    </div>
                  </Card>
                </Link>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

function Metric({ label, value, accent }: { label: string; value: string; accent?: boolean }) {
  return (
    <div>
      <p className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground">
        {label}
      </p>
      <p
        className={cn(
          "mt-1 font-serif text-xl font-semibold leading-none",
          accent ? "text-brand-orange" : "text-brand-navy",
        )}
      >
        {value}
      </p>
    </div>
  );
}
