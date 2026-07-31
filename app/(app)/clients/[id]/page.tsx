import Link from "next/link";
import { notFound } from "next/navigation";
import { format, parseISO } from "date-fns";
import { Loader2 } from "lucide-react";
import { requireUser } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { AutoRefresh } from "@/components/ui/auto-refresh";
import { GenerateReportButton } from "@/components/clients/generate-report-button";
import { CheckGrant } from "@/components/clients/check-grant";
import { InviteClientButton } from "@/components/clients/invite-client-button";
import { ClientContextBar } from "@/components/clients/client-context-bar";
import { GrantPipeline } from "@/components/clients/grant-pipeline";
import { Badge } from "@/components/ui/badge";
import { derivePipeline } from "@/lib/clients/pipeline";
import { inviteClientToPortalAction } from "../actions";
import { ClientDashboard, type DashActionItem } from "@/components/clients/client-dashboard";
import { type DashReportRow } from "@/components/clients/client-grant-report-card";
import { type DashDraft } from "@/components/clients/client-draft-progress";
import { deriveEnrichmentSteps } from "@/lib/clients/enrichment-status";
import { isUnconvertedLead } from "@/lib/leads/stage";
import { deadlineDaysLeft } from "@/lib/report/shape";
import type { Client, CardDecision, Grant, IntellEngineDraft } from "@/types/database";

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
  // Read by the pipeline derivation: the alert email physically went out.
  sent_at: string | null;
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
    .select("id, fit_score, decision, interested_at, sme_interested_at, sme_released_at, sent_at, grants(id, title, funder, submission_deadline)")
    .eq("client_id", params.id)
    .neq("card_type", "prospect");

  // The client's proposals in flight (migration 0062). Staff read every draft for
  // this client under the staff RLS policy; ordered the same way the IntellEngine hub
  // orders them, so the dashboard card leads with the same draft the hub does.
  const { data: draftRows } = await supabase
    .from("intellengine_drafts")
    .select("id, title, status, updated_at")
    .eq("client_id", params.id)
    .order("updated_at", { ascending: false });

  const drafts: DashDraft[] = ((draftRows ?? []) as Pick<
    IntellEngineDraft,
    "id" | "title" | "status" | "updated_at"
  >[]).map((d) => ({ id: d.id, title: d.title, status: d.status }));

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

  const base = `/clients/${client.id}/roadmap`;
  const alertsHref = `${base}/triage`;
  const editHref = `/clients/${client.id}/edit`;
  // The API-data view is a SECTION of Edit profile now, not its own route/button.
  const apiDataHref = `${editHref}?section=api`;
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

  // The pipeline replaces the four stat tiles. Same rows the page already loaded, one
  // pure cascade over them -- see lib/clients/pipeline.ts for why four stages and not
  // the five the design asked for.
  const pipeline = derivePipeline(cards);

  // Grant Report card: the strongest live matches, highest fit first, then soonest
  // deadline as the tiebreak (among equal fits, the one with a clock on it is the one
  // to look at). Passed cards are excluded -- they are a closed decision, and the card
  // is about what is still open. Staff see every non-passed card including ones not
  // yet released to the client, which is exactly what their own roadmap list shows.
  const REPORT_ROWS = 3;
  const liveCards = cards.filter((c) => c.decision !== "passed");
  const reportRows: DashReportRow[] = [...liveCards]
    .sort((a, b) => {
      if (b.fit_score !== a.fit_score) return b.fit_score - a.fit_score;
      const da = deadlineDaysLeft(a.grant?.submission_deadline);
      const db = deadlineDaysLeft(b.grant?.submission_deadline);
      // No deadline sorts last rather than first -- null is "unknown", not "urgent".
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

  // "Client since" only when there IS a contract start. Otherwise this reports when the
  // record was created and says so -- those are different facts, and labelling a
  // created_at as "client since" would overstate the relationship by however long the
  // record sat unsigned.
  const since = client.contract_start
    ? `Client since ${format(parseISO(client.contract_start), "MMM yyyy")}`
    : `Added ${format(parseISO(client.created_at), "MMM yyyy")}`;
  const contextMeta = [
    client.org_type?.replace(/_/g, " "),
    [client.location_city, client.location_state].filter(Boolean).join(", ") || null,
    since,
  ]
    .filter(Boolean)
    .join(" · ");
  const monogram = (() => {
    const parts = client.name.trim().split(/\s+/).filter(Boolean);
    if (parts.length === 0) return "—";
    if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
    return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
  })();

  // No visible banner: the action item carries the spinner and the message now, and
  // saying it twice on one screen read as clutter. AutoRefresh still mounts, because
  // results appearing without a manual reload is behaviour, not decoration.
  const matchNote = matchInProgress ? <AutoRefresh enabled /> : null;

  const actions = (
    <>
      <Link
        href={editHref}
        className="rounded-md border border-edge px-3 py-1.5 text-[12.5px] font-semibold text-ink-muted transition-colors hover:bg-page hover:text-brand-navy"
      >
        Edit profile
      </Link>
      <GenerateReportButton
        clientId={client.id}
        inProgress={matchInProgress}
        confirmRerun={confirmRerun}
        idleLabel={cards.length === 0 ? "Run Grant Matches" : "Refresh matches"}
      />
      {/* Only at the end of the onboarding sequence: grants matched AND reviewed,
          client not yet seated. Showing it earlier would invite the client to a portal
          with nothing in it. */}
      {showInvite && (
        <InviteClientButton
          clientName={client.name}
          contactEmail={client.primary_contact_email}
          action={inviteClientToPortalAction.bind(null, client.id)}
        />
      )}
    </>
  );

  return (
    <div className="relative min-h-full">
      {/* Full-bleed, so it sits OUTSIDE the dashboard's max-w content column -- it is
          chrome continuous with the command band above it, not page content. */}
      <ClientContextBar
        name={client.name}
        monogram={monogram}
        statusChip={<Badge variant="secondary">{isLead ? "prospect" : client.status}</Badge>}
        meta={contextMeta}
        actions={actions}
        backHref="/clients"
        backLabel="Portfolio"
      />
      <div className="relative">
        <ClientDashboard
        name={client.name}
        subLine={subLine}
        isStaff
        roadmapHref={base}
        intellEngineHref={`/clients/${client.id}/intellengine`}
        hero={<GrantPipeline pipeline={pipeline} />}
        actionItems={actionItems}
        activity={counts}
        report={{
          rows: reportRows,
          total: liveCards.length,
          emptyNote: matchInProgress
            ? "Matching is running — opportunities will appear here as they are scored."
            : "No matches yet. Run grant matches to surface opportunities.",
        }}
        drafts={{
          list: drafts,
          emptyNote: "No proposals started yet. IntellEngine is where a matched grant becomes a draft.",
        }}
        bookingUrl={process.env.NEXT_PUBLIC_BOOKING_URL ?? null}
        matchNote={matchNote}
        staffTools={isLead ? undefined : <CheckGrant clientId={client.id} clientName={client.name} />}
        />
      </div>
    </div>
  );
}
