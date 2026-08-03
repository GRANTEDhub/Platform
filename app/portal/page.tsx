import { format, parseISO } from "date-fns";
import { Bell } from "lucide-react";
import { requireClient } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { ClientDashboard, type DashPinnedRow } from "@/components/clients/client-dashboard";
import { ClientMasthead } from "@/components/clients/client-masthead";
import { rollUpPortal } from "@/lib/clients/dashboard-summary";
import { type DashReportRow } from "@/components/clients/client-grant-report-card";
import { type DashDraft } from "@/components/clients/client-draft-progress";
import { buildCommunityView } from "@/lib/clients/community";
import { deadlineDaysLeft } from "@/lib/report/shape";
import { deriveClientNotifications } from "@/lib/portal/notifications";
import { deriveActivity } from "@/lib/clients/activity";
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
  decided_at: string | null;
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
    .select(
      "id, fit_score, decision, decided_at, interested_at, sme_released_at, grants(id, title, funder, submission_deadline)",
    )
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

  const draftRecords = (draftRows ?? []) as Pick<
    IntellEngineDraft,
    "id" | "title" | "status" | "updated_at"
  >[];
  const drafts: DashDraft[] = draftRecords.map((d) => ({ id: d.id, title: d.title, status: d.status }));

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
  const { items: allActionItems } = deriveClientNotifications({
    cards: allCards,
    managed,
    nextStep: client?.next_step ?? null,
    profileConfirmed: !!client?.profile_confirmed_at,
  });

  // The grant-alerts item is dropped because the PINNED row below says the same thing and
  // is always present. The bell keeps its own copy (it has no pinned rows), so the shared
  // derivation still emits it -- this filters only what this page renders, and only the one
  // row that would otherwise appear twice on the same card.
  const actionItems = allActionItems.filter((i) => i.id !== "grant-alerts");

  // Upcoming deadlines (real) among live matches -- drives the deadline stat + the
  // action-items list.
  const upcoming = nonPassed
    .map((c) => ({ c, days: deadlineDaysLeft(c.grant?.submission_deadline), date: c.grant?.submission_deadline ?? null }))
    .filter((x): x is { c: (typeof nonPassed)[number]; days: number; date: string } => x.days !== null && x.days >= 0)
    .sort((a, b) => a.days - b.days);
  const nextDeadline = upcoming[0] ? format(parseISO(upcoming[0].date), "MMM d") : "—";

  // The client's own funnel, in their language — four stages, starting at the alerts we
  // have sent them rather than at our own unassessed queue. See rollUpPortal.
  const book = rollUpPortal(cards);
  const alertsToReview = book.stages.find((s) => s.key === "triage")?.count ?? 0;
  const nextDeadlineDays = upcoming[0]?.days ?? null;

  // ALWAYS PRESENT, count or no count. Grant Alerts is the front of their whole process —
  // a grant cannot reach their Grant Report until they mark it interested — so the row
  // that says how many are waiting must be a fixture rather than something that appears
  // only when non-zero. At zero it reads as caught up, which is information too.
  const pinnedRows: DashPinnedRow[] = [
    {
      id: "grant-alerts",
      title: "Grant alerts pending your review",
      description:
        alertsToReview > 0
          ? "Open each one, then mark it interested to move it into your Grant Report, or pass on it."
          : "Nothing waiting. New matches land here first.",
      count: alertsToReview,
      icon: Bell,
      tone: "triage",
      href: alertsToReview > 0 ? "/portal/triage" : null,
      actionLabel: "Review alerts",
    },
  ];

  // Rail: what has moved lately, in the CLIENT's voice — see ActivityVoice in
  // lib/clients/activity.ts. Same events, same tones, same rollup rules as staff get.
  //
  // `carded` is EMPTY and has to be: those timestamps live in match_attempts, which is
  // staff-only under RLS (0055). For a premium client that costs nothing — a grant
  // arriving IS the release, which the next line covers. For a standard client, who has no
  // release step, it means new grants do not announce themselves in the feed; their alerts
  // count and the pinned row carry that instead.
  const now = Date.now();
  const events = deriveActivity(
    {
      carded: [],
      decided: cards
        .filter((c) => (c.decision === "approved" || c.decision === "passed") && c.decided_at !== null)
        .map((c) => ({
          id: c.id,
          title: c.grant?.title || "Untitled opportunity",
          decision: c.decision as "approved" | "passed",
          at: c.decided_at as string,
        })),
      released: cards
        .filter((c) => c.sme_released_at !== null)
        .map((c) => ({ id: c.id, title: c.grant?.title || "Untitled opportunity", at: c.sme_released_at as string })),
      drafts: draftRecords.map((d) => ({ id: d.id, title: d.title, at: d.updated_at })),
      now,
    },
    "client",
  );

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

  // NO WRAPPER DIVS. ClientDashboard opens with `flex min-h-full flex-col`, and the console
  // renders it as a DIRECT child of a flex-1 <main> — which is what gives it a definite
  // height for the flex-1 cards inside to stretch into. The portal used to wrap it in two
  // divs, the inner one with no height class, so min-h-full resolved against auto height
  // and the Grant Report and IntellEngine panels collapsed to their content.
  return (
        <ClientDashboard
          name={org.clientName}
          subLine={subLine}
          isStaff={false}
          roadmapHref={base}
          intellEngineHref="/intellengine"
          // Same masthead component staff get, variant="portal" swapping the four figures
          // and the stage labels. No backlog sparkline: it measures our throughput.
          hero={
            <ClientMasthead
              name={org.clientName}
              meta={subLine}
              statusLabel={managed ? "premium" : "client"}
              variant="portal"
              portalFigures={{
                alerts: alertsToReview,
                inReport: counts.pending,
                approved: counts.approved,
              }}
              book={book}
              decided={counts.approved}
              nextDeadlineDays={nextDeadlineDays}
              backlog={null}
              nextDeadlineLabel={nextDeadline !== "—" ? nextDeadline : null}
              backHref="/portal/grants"
              backLabel="Grant Report"
            />
          }
          actionItems={actionItems}
          pinnedRows={pinnedRows}
          events={events}
          report={{
            rows: reportRows,
            total: nonPassed.length,
            emptyNote: "Your team is still working through opportunities. Matches will appear here as they are released.",
          }}
          drafts={{
            list: drafts,
            emptyNote: "No proposals started yet. IntellEngine is where a matched grant becomes a draft.",
          }}
          // Public Census/HRSA facts about the client's OWN community -- the same need
          // signals their proposals cite, so they see what grounds the narrative.
          // Pure read; `client` is null only if the row vanished mid-session.
          community={client ? buildCommunityView(client) : undefined}
        />
  );
}
