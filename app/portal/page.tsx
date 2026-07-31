import { format, parseISO } from "date-fns";
import { TrendingUp, Eye, Target, CalendarClock } from "lucide-react";
import { requireClient } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import {
  ClientDashboard,
  type DashStat,
} from "@/components/clients/client-dashboard";
import { type DashReportRow } from "@/components/clients/client-grant-report-card";
import { type DashDraft } from "@/components/clients/client-draft-progress";
import { deadlineDaysLeft } from "@/lib/report/shape";
import { deriveClientNotifications } from "@/lib/portal/notifications";
import type { Client, CardDecision, Grant, IntellEngineDraft } from "@/types/database";

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
  interested_at: string | null;
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

export default async function PortalHome() {
  const { memberships } = await requireClient();
  const org = memberships[0];
  const supabase = createClient();

  const { data: client } = await supabase.from("clients").select("*").eq("id", org.clientId).single<Client>();

  const { data: cardRows } = await supabase
    .from("review_cards")
    .select("id, fit_score, decision, interested_at, sme_released_at, grants(id, title, funder, submission_deadline)")
    .eq("client_id", org.clientId)
    .neq("card_type", "prospect");

  // This org's proposals in flight (migration 0062), read under the client member
  // RLS policy -- same query and ordering the IntellEngine hub itself uses, so the
  // dashboard card leads with the draft the hub leads with.
  const { data: draftRows } = await supabase
    .from("intellengine_drafts")
    .select("id, title, status, updated_at")
    .eq("client_id", org.clientId)
    .order("updated_at", { ascending: false });

  const drafts: DashDraft[] = ((draftRows ?? []) as Pick<
    IntellEngineDraft,
    "id" | "title" | "status" | "updated_at"
  >[]).map((d) => ({ id: d.id, title: d.title, status: d.status }));

  const allCards = ((cardRows ?? []) as CardRow[]).map((r) => ({ ...r, grant: grantOf(r.grants) }));
  // For an account-managed client (0059), a card not yet released by staff must
  // be entirely invisible here -- not counted, not surfaced in a deadline, not
  // hinted at -- otherwise the dashboard leaks the existence of a match the
  // client isn't supposed to know about yet, defeating the whole point of the
  // SME gate. Standard clients: unchanged, every card is visible.
  const managed = !!client?.account_managed;
  const cards = managed ? allCards.filter((c) => c.sme_released_at !== null) : allCards;
  // "In review" now means interested-but-undecided (sitting in the Grant Report,
  // past the Grant Alerts gate) -- not-yet-triaged cards are a separate bucket
  // (newAlerts, below), not part of this count. See migration 0057.
  const counts = {
    pending: cards.filter((c) => c.interested_at !== null && c.decision === "pending").length,
    approved: cards.filter((c) => c.decision === "approved").length,
    passed: cards.filter((c) => c.decision === "passed").length,
  };
  const nonPassed = cards.filter((c) => c.decision !== "passed");
  // Action items come from the shared derivation the header notification bell
  // also uses -- one source of truth, so the dashboard and the bell can never
  // disagree. Pass the unfiltered cards; derive re-applies the same
  // account-managed sme_released_at gate internally.
  const { items: actionItems } = deriveClientNotifications({
    cards: allCards,
    managed,
    nextStep: client?.next_step ?? null,
    profileConfirmed: !!client?.profile_confirmed_at,
  });

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

  // Grant Report card: strongest live matches first, soonest deadline as the tiebreak.
  // Built from `cards`, which for an account-managed client is ALREADY filtered to
  // released rows -- so an unreleased match cannot surface here any more than it can in
  // the counts above.
  const REPORT_ROWS = 3;
  const reportRows: DashReportRow[] = [...nonPassed]
    .sort((a, b) => {
      if (b.fit_score !== a.fit_score) return b.fit_score - a.fit_score;
      const da = deadlineDaysLeft(a.grant?.submission_deadline);
      const db = deadlineDaysLeft(b.grant?.submission_deadline);
      // No deadline sorts last -- null is "unknown", not "urgent".
      return (da ?? Number.POSITIVE_INFINITY) - (db ?? Number.POSITIVE_INFINITY);
    })
    .slice(0, REPORT_ROWS)
    .map((c) => ({
      cardId: c.id,
      title: c.grant?.title || "Untitled opportunity",
      funder: c.grant?.funder ?? null,
      fitScore: c.fit_score,
      deadline: c.grant?.submission_deadline
        ? format(parseISO(c.grant.submission_deadline), "MMM d")
        : null,
      href: `${base}/${c.id}`,
    }));

  const subLine =
    [client?.org_type?.replace(/_/g, " "), client?.location_city, client?.location_state].filter(Boolean).join(" · ") || null;

  return (
    <div className="relative min-h-full">
      <div className="relative">
        <ClientDashboard
          name={org.clientName}
          subLine={subLine}
          isStaff={false}
          roadmapHref={base}
          intellEngineHref="/intellengine"
          stats={stats}
          actionItems={actionItems}
          activity={counts}
          report={{
            rows: reportRows,
            total: nonPassed.length,
            emptyNote: "Your team is still working through opportunities. Matches will appear here as they are released.",
          }}
          drafts={{
            list: drafts,
            emptyNote: "No proposals started yet. IntellEngine is where a matched grant becomes a draft.",
          }}
          bookingUrl={process.env.NEXT_PUBLIC_BOOKING_URL ?? null}
        />
      </div>
    </div>
  );
}
