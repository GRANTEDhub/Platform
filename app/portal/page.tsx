import { format, parseISO } from "date-fns";
import { TrendingUp, Eye, Target, CalendarClock } from "lucide-react";
import { requireClient } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { PageBackdrop } from "@/components/layout/page-backdrop";
import {
  ClientDashboard,
  type DashActionItem,
  type DashStat,
} from "@/components/clients/client-dashboard";
import { deadlineDaysLeft } from "@/lib/report/shape";
import type { Client, CardDecision, Grant } from "@/types/database";

export const dynamic = "force-dynamic";

// The client's landing page (Phase 2) -- the same ClientDashboard the staff
// account-manager view mounts at /clients/[id], just isStaff={false}. Reads
// under RLS as the logged-in client (0055 policies), so it can only ever see
// this client's own row + matches. The Grant Report list itself now lives at
// /portal/grants (moved out of this route to make room for the dashboard);
// this page's "Grant Report" tile links there.
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

export default async function PortalHome() {
  const { memberships } = await requireClient();
  const org = memberships[0];
  const supabase = createClient();

  const { data: client } = await supabase.from("clients").select("*").eq("id", org.clientId).single<Client>();

  const { data: cardRows } = await supabase
    .from("review_cards")
    .select("id, fit_score, decision, grants(id, title, funder, submission_deadline)")
    .eq("client_id", org.clientId)
    .neq("card_type", "prospect");

  const cards = ((cardRows ?? []) as CardRow[]).map((r) => ({ ...r, grant: grantOf(r.grants) }));
  const counts = {
    pending: cards.filter((c) => c.decision === "pending").length,
    approved: cards.filter((c) => c.decision === "approved").length,
    passed: cards.filter((c) => c.decision === "passed").length,
  };
  const nonPassed = cards.filter((c) => c.decision !== "passed");

  // Upcoming deadlines (real) among live matches -- drives the deadline stat + the
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

  const base = "/portal/grants";
  const actionItems: DashActionItem[] = [];
  if (counts.pending > 0) {
    actionItems.push({ id: "catch-up", title: `Catch up on grant alerts · ${counts.pending} new`, href: base });
  }
  if (client?.next_step) {
    actionItems.push({ id: "next-step", title: client.next_step, tag: "From your team", priority: "high" });
  }

  const subLine =
    [client?.org_type?.replace(/_/g, " "), client?.location_city, client?.location_state].filter(Boolean).join(" · ") || null;

  return (
    <div className="relative min-h-full">
      <PageBackdrop />
      <div className="relative">
        <ClientDashboard
          name={org.clientName}
          subLine={subLine}
          isStaff={false}
          roadmapHref={base}
          stats={stats}
          actionItems={actionItems}
          activity={counts}
          bookingUrl={process.env.NEXT_PUBLIC_BOOKING_URL ?? null}
        />
      </div>
    </div>
  );
}
