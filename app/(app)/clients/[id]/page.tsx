import { notFound } from "next/navigation";
import { format, parseISO } from "date-fns";
import { Loader2, TrendingUp, Eye, Target, CalendarClock } from "lucide-react";
import { requireAdmin } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { AutoRefresh } from "@/components/ui/auto-refresh";
import { GenerateReportButton } from "@/components/clients/generate-report-button";
import {
  ClientDashboard,
  type DashActionItem,
  type DashRoadmapPick,
  type DashStat,
} from "@/components/clients/client-dashboard";
import { deadlineDaysLeft } from "@/lib/report/shape";
import type { Client, CardDecision, Grant } from "@/types/database";

export const dynamic = "force-dynamic";

// The per-client dashboard — now the shared, actor-aware hub (Figma format). Staff
// view (isStaff) mounts here; the client portal mounts the same component (Phase 2).
// Staff-internal detail (contact / engagement / billing / portal access / repository
// / notes) lives on Edit profile, not here. Ledger click-throughs are gone — grant
// ops live in the Ledger only.
type CardRow = {
  id: string;
  fit_score: 1 | 2 | 3;
  decision: CardDecision;
  grants:
    | Pick<Grant, "id" | "title" | "funder" | "submission_deadline">
    | Pick<Grant, "id" | "title" | "funder" | "submission_deadline">[]
    | null;
};

function grantOf(g: CardRow["grants"]) {
  if (!g) return null;
  return Array.isArray(g) ? g[0] ?? null : g;
}

export default async function ClientDashboardPage({ params }: { params: { id: string } }) {
  await requireAdmin();
  const supabase = createClient();

  const { data: client } = await supabase.from("clients").select("*").eq("id", params.id).single<Client>();
  if (!client) notFound();

  const { data: cardRows } = await supabase
    .from("review_cards")
    .select("id, fit_score, decision, grants(id, title, funder, submission_deadline)")
    .eq("client_id", params.id)
    .neq("card_type", "prospect");

  const cards = ((cardRows ?? []) as CardRow[]).map((r) => ({ ...r, grant: grantOf(r.grants) }));
  const counts = {
    pending: cards.filter((c) => c.decision === "pending").length,
    approved: cards.filter((c) => c.decision === "approved").length,
    passed: cards.filter((c) => c.decision === "passed").length,
  };
  const nonPassed = cards.filter((c) => c.decision !== "passed");

  // Upcoming deadlines (real) among live matches — drives the deadline stat + the
  // action-items list.
  const upcoming = nonPassed
    .map((c) => ({ c, days: deadlineDaysLeft(c.grant?.submission_deadline), date: c.grant?.submission_deadline ?? null }))
    .filter((x): x is { c: (typeof nonPassed)[number]; days: number; date: string } => x.days !== null && x.days >= 0)
    .sort((a, b) => a.days - b.days);
  const dueSoon = upcoming.filter((x) => x.days <= 30).length;
  const nextDeadline = upcoming[0] ? format(parseISO(upcoming[0].date), "MMM d") : "—";

  const stats: DashStat[] = [
    { label: "Active grants", value: String(counts.approved), sub: dueSoon ? `${dueSoon} due in 30 days` : "being pursued", icon: TrendingUp },
    { label: "In review", value: String(counts.pending), sub: "awaiting decision", icon: Eye },
    { label: "Matched", value: String(nonPassed.length), sub: "opportunities", icon: Target },
    { label: "Next deadline", value: nextDeadline, sub: null, icon: CalendarClock, accent: true },
  ];

  const base = `/clients/${client.id}/roadmap`;
  const actionItems: DashActionItem[] = [];
  if (client.next_step) {
    actionItems.push({ id: "next-step", title: client.next_step, tag: "From your team", priority: "high" });
  }
  for (const x of upcoming.slice(0, 5)) {
    actionItems.push({
      id: x.c.id,
      title: `Prepare ${x.c.grant?.title || "grant"}`,
      tag: x.c.grant?.funder || null,
      date: format(parseISO(x.date), "MMM d, yyyy"),
      priority: x.days <= 14 ? "high" : "medium",
      href: `${base}/${x.c.id}`,
    });
  }

  const roadmapPicks: DashRoadmapPick[] = [...nonPassed]
    .sort((a, b) => b.fit_score - a.fit_score)
    .slice(0, 3)
    .map((c) => ({ cardId: c.id, title: c.grant?.title || "Untitled opportunity", fitScore: c.fit_score }));

  const matchStatus = client.initial_match_status;
  const matchInProgress = matchStatus === "queued" || matchStatus === "running";
  const confirmRerun = matchStatus === "complete" || matchStatus === "error" || cards.length > 0;

  const subLine =
    [client.org_type?.replace(/_/g, " "), client.location_city, client.location_state].filter(Boolean).join(" · ") || null;

  const matchNote = matchInProgress ? (
    <div className="mt-4 flex items-center gap-2 rounded-xl bg-brand-orange/10 px-4 py-3 text-sm font-medium text-brand-navy ring-1 ring-brand-orange/30">
      <Loader2 className="h-4 w-4 shrink-0 animate-spin text-brand-orange" />
      Matching in progress — results refresh automatically.
      <AutoRefresh enabled />
    </div>
  ) : null;

  return (
    <div className="min-h-full bg-brand-cream">
      <ClientDashboard
        name={client.name}
        subLine={subLine}
        isStaff
        roadmapHref={base}
        stats={stats}
        actionItems={actionItems}
        activity={counts}
        roadmapPicks={roadmapPicks}
        matchedCount={nonPassed.length}
        editHref={`/clients/${client.id}/edit`}
        refresh={
          <GenerateReportButton
            clientId={client.id}
            inProgress={matchInProgress}
            confirmRerun={confirmRerun}
            idleLabel="Refresh matches"
          />
        }
        matchNote={matchNote}
      />
    </div>
  );
}
