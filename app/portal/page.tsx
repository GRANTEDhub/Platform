import Link from "next/link";
import { format, parseISO } from "date-fns";
import { Bell, ClipboardCheck } from "lucide-react";
import { requireClient } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { ClientDashboard, type DashPinnedRow } from "@/components/clients/client-dashboard";
import { pursuitClientAccessEnabled, intellEngineComingSoon } from "@/lib/pursuit/access";
import { ClientMasthead } from "@/components/clients/client-masthead";
import { CheckGrant } from "@/components/clients/check-grant";
import { AutoRefresh } from "@/components/ui/auto-refresh";
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
    .select("id, title, status, content, updated_at")
    .eq("client_id", org.clientId)
    .order("updated_at", { ascending: false });

  const draftRecords = (draftRows ?? []) as Pick<
    IntellEngineDraft,
    "id" | "title" | "status" | "content" | "updated_at"
  >[];
  // content, not status: the card's progress is derived from what the draft holds (0074).
  const drafts: DashDraft[] = draftRecords.map((d) => ({ id: d.id, title: d.title, content: d.content }));

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

  // Both of these are dropped because a PINNED row below says the same thing and is always
  // present. The bell keeps its own copies (it has no pinned rows), so the shared derivation
  // still emits them -- this filters only what this page renders, and only the rows that
  // would otherwise appear twice on the same card.
  const DUPLICATED_BY_PINNED = new Set(["grant-alerts", "grant-report-pending"]);
  const actionItems = allActionItems.filter((i) => !DUPLICATED_BY_PINNED.has(i.id));

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
  // TWO PINNED ROWS, one per stage of the client's own funnel, so the card names both
  // things that can be waiting on them rather than only the front of the queue. At zero
  // each reads as cleared and yields its slot to a real dynamic item (see the ordering note
  // on DashPinnedRow), which is what keeps a three-row card spent on actual work.
  //
  // There is deliberately no third "messages" row. In-app messaging does not exist, and a
  // permanently-zero row for an unbuilt feature is the "Soon" nav link again -- the card
  // reaches its three rows through the floor instead.
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
    {
      id: "report-pending",
      title: "Grants awaiting your decision",
      description:
        counts.pending > 0
          ? "In your Grant Report, past the alerts gate — choose how you want to pursue each one, or pass."
          : "Nothing waiting. Grants you mark interested land here.",
      count: counts.pending,
      icon: ClipboardCheck,
      // The client stage, so this row and its pipeline column read as the same thing.
      tone: "client",
      href: counts.pending > 0 ? "/portal/grants" : null,
      actionLabel: "Open report",
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
      // Gated with the rest of Pursuit (lib/pursuit/access.ts). This was the one surface on
      // this page the gate missed: the nav tab, the tile href below, and the drafts panel all
      // hide, but the feed still emitted "Your proposal draft moved" for any draft touched in
      // the trailing 14 days -- naming a feature every other surface here now hides. No
      // click-through (ClientActivity renders plain text, no href), so this is a stale mention
      // rather than a dead end, but a client should not be told about a screen they cannot open.
      drafts: pursuitClientAccessEnabled()
        ? draftRecords.map((d) => ({ id: d.id, title: d.title, at: d.updated_at }))
        : [],
      now,
    },
    "client",
  );

  // The Grant Report card's three header figures, same as the console's and computed the
  // same way — over the client's LIVE set (passed excluded, which is a closed decision).
  // No `freshness`: "Updated 6d ago" reads as a promise about how often we look, and the
  // fact it is derived from is a staff-only match_attempts timestamp anyway.
  // THE REPORT'S OWN SET, which is not the same as "every non-passed card". /portal/grants
  // filters `interested_at is not null` -- a grant only reaches their Report once they mark
  // it interested in Grant Alerts. This card was built from every non-passed card, so a
  // brand-new alert appeared in the dashboard's Grant Report box AND in Grant Alerts, and
  // then was missing from the Report when you opened it. Same bug the console card had
  // (#291); it just never got applied on this side.
  const inReport = cards.filter((c) => c.interested_at !== null);
  const liveCards = inReport.filter((c) => c.decision !== "passed");
  const reportMetrics = {
    open: liveCards.filter((c) => c.decision === "pending").length,
    decided: inReport.filter((c) => c.decision === "approved").length,
    avgFit: liveCards.length
      ? (liveCards.reduce((n, c) => n + c.fit_score, 0) / liveCards.length).toFixed(1)
      : null,
  };

  const base = "/portal/grants";

  // Grant Report card: strongest live matches first, soonest deadline as the tiebreak.
  // Built from `cards`, which for an account-managed client is ALREADY filtered to
  // released rows -- so an unreleased match cannot surface here any more than it can in
  // the counts above.
  const REPORT_ROWS = 3;
  // AWAITING THEIR REVIEW, matching the Report's own default tab -- the rows are their
  // queue, not everything they hold. An approved grant is not waiting on them.
  const awaitingReview = liveCards.filter((c) => c.decision === "pending");
  const reportRows: DashReportRow[] = [...awaitingReview]
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
    <>
      {/* A NEW ALERT ARRIVES WITHOUT A PAGE LOAD. The email lands, and the dashboard kept
          showing pre-send counts until someone hit refresh -- so a client sitting on this
          tab could watch the alert email arrive and see nothing here. The page is
          force-dynamic, so each refresh re-reads.

          60s, not the 4s the console uses for a running match: this is ambient freshness
          for a queue that changes when WE send something, not progress on a job the viewer
          just started.

          A SIBLING, NOT A WRAPPER. AutoRefresh renders null, so the layout's flex <main>
          still sees exactly one real child -- wrapping ClientDashboard in a div is what
          collapsed the panels before (its min-h-full needs a definite-height parent).
          matchNote would have been the tidier slot but it is gated on isStaff. */}
      <AutoRefresh enabled intervalMs={60_000} />
      <ClientDashboard
          name={org.clientName}
          subLine={subLine}
          isStaff={false}
          roadmapHref={base}
          // TWO INDEPENDENT flags (lib/pursuit/access.ts). The live href is present only while client
          // access is enabled -- ClientDashboard renders the live panel only with BOTH drafts and an
          // href. Separately, intellEngineComingSoon() decides whether the slot shows the inert
          // "COMING SOON" tile when there is no live href; with both off the slot is empty. Access
          // wins: a live href is rendered live even if the teaser flag is also on.
          intellEngineHref={pursuitClientAccessEnabled() ? "/intellengine" : undefined}
          intellEngineComingSoon={intellEngineComingSoon()}
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
              // ALWAYS PRESENT, even with no dated deadline ahead: the slot beside Edit
              // profile went empty the moment nothing was upcoming, so the masthead's
              // right side changed shape depending on the data. "None upcoming" is
              // information; a missing row is not. nextDeadline is already "—" when there
              // is nothing, so only the wording needs the floor.
              nextDeadlineLabel={nextDeadline !== "—" ? nextDeadline : "None upcoming"}
              backHref="/portal/grants"
              backLabel="Grant Report"
              // Same slot the console uses for Edit profile / Refresh matches. A client gets
              // Edit profile only — /portal/profile already exists and is theirs to edit —
              // and never Refresh matches, which spends scorer calls.
              actions={
                <Link
                  href="/portal/profile"
                  className="inline-flex h-8 shrink-0 items-center rounded-[9px] bg-white px-[14px] text-[13px] font-semibold text-brand-navy transition-opacity duration-[120ms] hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-orange/60 focus-visible:ring-offset-2 focus-visible:ring-offset-brand-chrome"
                >
                  Edit profile
                </Link>
              }
            />
          }
          actionItems={actionItems}
          pinnedRows={pinnedRows}
          // The rail's scorer, same component and same slot the console uses. REPORT-ONLY
          // for a client: the route refuses to write a review_card from the portal, so this
          // answers "does this fit us" without putting a grant in their own Grant Report
          // that nobody on our side released. See app/api/clients/[id]/check-grant/route.ts.
          scorer={<CheckGrant clientId={org.clientId} clientName={org.clientName} variant="portal" />}
          events={events}
          report={{
            rows: reportRows,
            total: liveCards.length,
            metrics: reportMetrics,
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
    </>
  );
}
