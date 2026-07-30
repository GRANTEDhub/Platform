import { notFound } from "next/navigation";
import { format, parseISO } from "date-fns";
import { Loader2, TrendingUp, Eye, Target, CalendarClock } from "lucide-react";
import { requireUser } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { AutoRefresh } from "@/components/ui/auto-refresh";
import { PageBackdrop } from "@/components/layout/page-backdrop";
import { GenerateReportButton } from "@/components/clients/generate-report-button";
import { CheckGrant } from "@/components/clients/check-grant";
import { InviteClientButton } from "@/components/clients/invite-client-button";
import { inviteClientToPortalAction } from "../actions";
import {
  ClientDashboard,
  type DashActionItem,
  type DashStat,
} from "@/components/clients/client-dashboard";
import { deadlineDaysLeft } from "@/lib/report/shape";
import { deriveEnrichmentSteps } from "@/lib/clients/enrichment-status";
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

// What to actually DO about a data source that needs a human, phrased per field.
// "sam" covers both never-registered and expired -- either way the fix is the same
// SAM resolve/bind flow.
const RESOLVE_HINT: Record<string, string> = {
  ein: "look up the EIN to pull the 990",
  location_county: "add the county to derive rurality",
  sam: "resolve the SAM.gov registration",
  other: "needs a value",
};

function grantOf(g: CardRow["grants"]) {
  if (!g) return null;
  return Array.isArray(g) ? g[0] ?? null : g;
}

export default async function ClientDashboardPage({ params }: { params: { id: string } }) {
  await requireUser();
  const supabase = createClient();

  const { data: client } = await supabase.from("clients").select("*").eq("id", params.id).single<Client>();
  if (!client) notFound();

  const managed = !!client.account_managed;
  // A prospect (un-converted lead): no portal, so its whole scored queue is staff's
  // to review on the roadmap list — the "to review" action links there, not to the
  // client-alerts triage swipe.
  const isLead = isUnconvertedLead(client.pipeline_stage);

  // Seated portal members. Clients only -- a prospect has no portal, so the query is
  // skipped rather than returning a zero that would prompt a seat invite for a record
  // that cannot have one.
  const { count: memberCountRaw } = isLead
    ? { count: null }
    : await supabase
        .from("client_members")
        .select("id", { count: "exact", head: true })
        .eq("client_id", params.id);
  const memberCount = memberCountRaw ?? 0;

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
  const apiDataHref = `/clients/${client.id}/api-data`;
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
  // The invite control appears only at the sequence's final stage, so it and the
  // action item can never disagree about whether it is time.

  // ── ONBOARDING SEQUENCE (clients only, pre-invite) ────────────────────────
  //
  // Until the client has a portal seat, the dashboard shows exactly ONE action item:
  // whichever stage the record is actually at. Run matches -> (matching) -> review
  // the grants -> invite the client. One thing to do at a time, because this screen
  // is the account manager's script for a brand-new client and a list of four
  // simultaneous prompts does not tell you what to do first.
  //
  // NOTE this supersedes the earlier setup-first ordering (connect APIs -> portal
  // seats -> start matching). Portal seats deliberately moved to LAST: the invite is
  // what releases the client's report to them, so it belongs after the grants have
  // been reviewed, not before they exist. The API-data prompts are not dropped --
  // they return once the client is invited (below), where they read as maintenance
  // rather than competing with the sequence.
  const enrichmentSteps = deriveEnrichmentSteps(client);
  const unresolved = enrichmentSteps.filter((s) => s.state === "needs_input");
  const stillPending = enrichmentSteps.filter((s) => s.state === "pending" && !s.background);
  const inOnboarding = !isLead && memberCount === 0;
  const showInvite = inOnboarding && !matchInProgress && cards.length > 0 && toReview === 0;

  if (inOnboarding) {
    if (matchInProgress) {
      // Mirrors the button's own state so the two never disagree about whether
      // anything is happening.
      actionItems.push({
        id: "matching",
        title: "Matching grants — nothing to do while this runs",
        busy: true,
        stage: null,
      });
    } else if (cards.length === 0) {
      actionItems.push({
        id: "run-matches",
        title: "Run grant matches to surface opportunities",
        tag: "Use the button, top right",
        stage: { step: 1, total: 3 },
      });
    } else if (toReview > 0) {
      actionItems.push({
        id: "to-review",
        title: `Review ${toReview} matched grant${toReview === 1 ? "" : "s"}`,
        href: managed ? base : alertsHref,
        stage: { step: 2, total: 3 },
      });
    } else {
      // Reviewed and decided. The invite is the release: it seats the client AND is
      // what lets their alerts reach them (client-facing sends are held until a seat
      // exists), so it is deliberately the last step rather than the first.
      actionItems.push({
        id: "invite-client",
        title: "Invite the client to their portal",
        tag: "Grants are reviewed — this releases them",
        stage: { step: 3, total: 3 },
      });
    }
  }

  // A fresh record with no report yet: prompt to run matching (the button, top
  // right). Matching is MANUAL-ONLY by design -- auto-enqueuing on create once left
  // records stuck behind the 10-min cron with the manual button disabled, so nothing
  // could start at all (see createClientAction). This prompt is what makes the manual
  // step discoverable; without it a newly created record just looks empty.
  // Applies to CLIENTS as well as prospects -- a new client showed no matches and no
  // prompt, which read as "the platform isn't working" rather than "click here".
  // Data-source gaps, once the sequence is done. Maintenance, not onboarding.
  if (!inOnboarding && unresolved.length > 0) {
    actionItems.push({
      id: "connect-apis",
      title:
        unresolved.length === 1
          ? `${unresolved[0].label}: ${RESOLVE_HINT[unresolved[0].resolveField ?? "other"]}`
          : `${unresolved.length} data sources need attention`,
      tag: "API data",
      href: apiDataHref,
    });
  } else if (!inOnboarding && stillPending.length > 0) {
    actionItems.push({
      id: "connect-apis",
      title: `${stillPending.length} data pull${stillPending.length === 1 ? "" : "s"} haven't reported back`,
      tag: "API data",
      href: apiDataHref,
    });
  }

  if (!inOnboarding && cards.length === 0 && !matchInProgress) {
    actionItems.push({
      id: "run-matches",
      title: isLead
        ? "Run grant matches to surface opportunities"
        : "Run the first grant match for this client",
      tag: "Use the button, top right",
    });
  }
  if (!inOnboarding && toReview > 0) {
    actionItems.push({
      id: "to-review",
      title: `You have ${toReview} grant${toReview === 1 ? "" : "s"} to review`,
      href: managed || isLead ? base : alertsHref,
    });
  }
  if (!inOnboarding && counts.pending > 0) {
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
  if (!inOnboarding && client.next_step) {
    actionItems.push({ id: "next-step", title: client.next_step, tag: "From your team" });
  }

  const subLine =
    [client.org_type?.replace(/_/g, " "), client.location_city, client.location_state].filter(Boolean).join(" · ") || null;

  // No visible banner: the action item carries the spinner and the message now, and
  // saying it twice on one screen read as clutter. AutoRefresh still mounts, because
  // results appearing without a manual reload is behaviour, not decoration.
  const matchNote = matchInProgress ? <AutoRefresh enabled /> : null;

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
        editHref={`/clients/${client.id}/edit`}
        apiDataHref={apiDataHref}
        refresh={
          <>
            <GenerateReportButton
              clientId={client.id}
              inProgress={matchInProgress}
              confirmRerun={confirmRerun}
              idleLabel={cards.length === 0 ? "Run Grant Matches" : "Refresh matches"}
              tone="dark"
            />
            {/* Only at the end of the onboarding sequence: grants matched AND reviewed,
                client not yet seated. Showing it earlier would invite the client to a
                portal with nothing in it. */}
            {showInvite && (
              <InviteClientButton
                clientName={client.name}
                contactEmail={client.primary_contact_email}
                action={inviteClientToPortalAction.bind(null, client.id)}
              />
            )}
          </>
        }
        matchNote={matchNote}
        staffTools={isLead ? undefined : <CheckGrant clientId={client.id} clientName={client.name} />}
        />
      </div>
    </div>
  );
}
