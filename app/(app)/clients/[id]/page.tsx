import { notFound } from "next/navigation";
import { format, parseISO } from "date-fns";
import { Loader2, TrendingUp, Eye, Target, CalendarClock } from "lucide-react";
import { requireUser } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { AutoRefresh } from "@/components/ui/auto-refresh";
import { PageBackdrop } from "@/components/layout/page-backdrop";
import { GenerateReportButton } from "@/components/clients/generate-report-button";
import { CheckGrant } from "@/components/clients/check-grant";
import {
  ClientDashboard,
  type DashActionItem,
  type DashStat,
} from "@/components/clients/client-dashboard";
import { deadlineDaysLeft } from "@/lib/report/shape";
import { isUnconvertedLead } from "@/lib/leads/stage";
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
  interested_at: string | null;
  sme_interested_at: string | null;
  sme_released_at: string | null;
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
  // Contractors see the client dashboard (grant work), but NOT Edit profile, which
  // holds engagement/billing/contract/repository -- so the Edit link is admin-only
  // and the Edit page itself stays requireAdmin as the hard backstop.
  const profile = await requireUser();
  const isAdmin = profile.role === "admin";
  const supabase = createClient();

  const { data: client } = await supabase.from("clients").select("*").eq("id", params.id).single<Client>();
  if (!client) notFound();

  const managed = !!client.account_managed;
  // A prospect (un-converted lead): no portal, so its whole scored queue is staff's
  // to review on the roadmap list — the "to review" action links there, not to the
  // client-alerts triage swipe.
  const isLead = isUnconvertedLead(client.pipeline_stage);

  const { data: cardRows } = await supabase
    .from("review_cards")
    .select("id, fit_score, decision, interested_at, sme_interested_at, sme_released_at, grants(id, title, funder, submission_deadline)")
    .eq("client_id", params.id)
    .neq("card_type", "prospect");

  const cards = ((cardRows ?? []) as CardRow[]).map((r) => ({ ...r, grant: grantOf(r.grants) }));
  // "In review" now means interested-but-undecided (sitting in the Grant Report,
  // past the Grant Alerts gate) -- not-yet-triaged cards are a separate bucket
  // (newAlerts, below), not part of this count. See migration 0057.
  const counts = {
    pending: cards.filter((c) => c.interested_at !== null && c.decision === "pending").length,
    approved: cards.filter((c) => c.decision === "approved").length,
    passed: cards.filter((c) => c.decision === "passed").length,
  };
  // Staff's OWN review queue. For an account-managed client (0059) this is now a
  // SINGLE gate (the sme_interested triage was removed): everything not yet released
  // to the client. For a standard client it is the client-alerts convenience --
  // their not-yet-triaged matches (staff acting on the client's behalf).
  const toReview = managed
    ? cards.filter((c) => c.sme_released_at === null && c.decision !== "passed").length
    : cards.filter((c) => c.interested_at === null && c.decision !== "passed").length;
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
  const alertsHref = `${base}/triage`;
  // Action items: staff's own review queue, then the client's next step. For an
  // account-managed client the review is a SINGLE gate (the roadmap review list at
  // `base`, where why-it-matches + manual concept generate/edit + release live), so
  // "to review" links straight there. For a standard client it's the Grant Alerts
  // swipe convenience (`alertsHref`). The client's own decision status is a separate,
  // clearly-labeled read-only line so it's never confused with staff's to-dos.
  const matchStatus = client.initial_match_status;
  const matchInProgress = matchStatus === "queued" || matchStatus === "running";
  const confirmRerun = matchStatus === "complete" || matchStatus === "error" || cards.length > 0;

  const actionItems: DashActionItem[] = [];
  // A fresh prospect with no report yet: prompt the AM to run matching (the button,
  // top right). Once cards land, the "to review" item below takes over.
  if (isLead && cards.length === 0 && !matchInProgress) {
    actionItems.push({
      id: "run-matches",
      title: "Run grant matches to surface opportunities",
      tag: "Use the button, top right",
      priority: "high",
    });
  }
  if (toReview > 0) {
    actionItems.push({
      id: "to-review",
      title: `You have ${toReview} grant${toReview === 1 ? "" : "s"} to review`,
      href: managed || isLead ? base : alertsHref,
    });
  }
  if (counts.pending > 0) {
    actionItems.push({
      id: "grant-report-pending",
      title: managed
        ? `${counts.pending} grant${counts.pending === 1 ? "" : "s"} awaiting the client's decision`
        : `${counts.pending} grant${counts.pending === 1 ? "" : "s"} awaiting a decision`,
      // Managed: informational only -- there's no staff-side page for "the
      // client's own decision status" to link to; the decision itself happens on
      // the client's own Grant Report. Standard: unchanged, links to staff's
      // mirror of the client's Grant Report (base already shows exactly that).
      href: managed ? null : base,
    });
  }
  if (client.next_step) {
    actionItems.push({ id: "next-step", title: client.next_step, tag: "From your team", priority: "high" });
  }

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
    <div className="relative min-h-full">
      <PageBackdrop />
      <div className="relative">
        <ClientDashboard
        name={client.name}
        subLine={subLine}
        isStaff
        roadmapHref={base}
        intellEngineHref={`/clients/${client.id}/intellengine`}
        stats={stats}
        actionItems={actionItems}
        activity={counts}
        bookingUrl={process.env.NEXT_PUBLIC_BOOKING_URL ?? null}
        editHref={isAdmin ? `/clients/${client.id}/edit` : undefined}
        refresh={
          <GenerateReportButton
            clientId={client.id}
            inProgress={matchInProgress}
            confirmRerun={confirmRerun}
            idleLabel={isLead ? "Run Grant Matches" : "Refresh matches"}
            tone="dark"
          />
        }
        matchNote={matchNote}
        staffTools={isLead ? undefined : <CheckGrant clientId={client.id} clientName={client.name} />}
        />
      </div>
    </div>
  );
}
