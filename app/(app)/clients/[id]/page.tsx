import Link from "next/link";
import { notFound } from "next/navigation";
import { format, parseISO } from "date-fns";
import { Clock, Layers, Loader2, Mail, MessageSquareText, Plug, Play, Sparkles, type LucideIcon } from "lucide-react";
import { requireUser } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { AutoRefresh } from "@/components/ui/auto-refresh";
import { GenerateReportButton } from "@/components/clients/generate-report-button";
import { CheckGrant } from "@/components/clients/check-grant";
import { InviteClientButton } from "@/components/clients/invite-client-button";
import { ClientContextBar } from "@/components/clients/client-context-bar";
import { GrantPipeline } from "@/components/clients/grant-pipeline";
import { Badge } from "@/components/ui/badge";
import { derivePipeline, stageOf, type PipelineStageKey } from "@/lib/clients/pipeline";
import { inviteClientToPortalAction } from "../actions";
import { ClientDashboard, type DashActionItem, type DashPinnedRow } from "@/components/clients/client-dashboard";
import { type DashReportRow } from "@/components/clients/client-grant-report-card";
import { type DashDraft } from "@/components/clients/client-draft-progress";
import { type DashDeadline } from "@/components/clients/upcoming-deadlines";
import { buildCommunityView } from "@/lib/clients/community";
import { deriveEnrichmentSteps } from "@/lib/clients/enrichment-status";
import { isUnconvertedLead } from "@/lib/leads/stage";
import { deadlineDaysLeft } from "@/lib/report/shape";
import { formatAwardRange } from "@/lib/grants/format";
import type { Client, CardDecision, Grant, IntellEngineDraft, PursuitPath } from "@/types/database";

export const dynamic = "force-dynamic";

// The per-client dashboard — now the shared, actor-aware hub (Figma format). Staff
// view (isStaff) mounts here; the client portal mounts the same component (Phase 2).
// Staff-internal detail (contact / engagement / billing / portal access / repository
// / notes) lives on Edit profile, not here. Ledger click-throughs are gone — grant
// ops live in the Ledger only.
// The grant columns this page reads. award_range_* feed the Grant Report card's amount,
// which must carry an estimate marker when award_range_is_estimate is set -- an
// unlabelled figure on a staff surface is one that gets quoted to a client as fact.
type GrantEmbed = Pick<
  Grant,
  "id" | "title" | "funder" | "submission_deadline" | "award_range_min" | "award_range_max" | "award_range_is_estimate"
>;

type CardRow = {
  id: string;
  fit_score: 1 | 2 | 3;
  decision: CardDecision;
  interested_at: string | null;
  sme_interested_at: string | null;
  sme_released_at: string | null;
  // Read by the pipeline derivation: the alert email physically went out.
  sent_at: string | null;
  // Also the pipeline's: null on an approved card means the decision is recorded but
  // the pursuit path is still open, which is the Approved stage rather than In pursuit.
  pursuit_path: PursuitPath | null;
  grants: GrantEmbed | GrantEmbed[] | null;
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

// Award figure for a Grant Report row, or null when the grant carries no range.
//
// formatAwardRange returns "—" for "no figure at all"; that is a placeholder, not a
// value, so it becomes null here and the row simply omits the segment rather than
// printing a dash between two real facts.
//
// The "est." suffix is not cosmetic: award amounts are estimates unless the NOFO states
// otherwise, and an unlabelled figure on a staff surface is one that gets read out to a
// client as fact. The flag is already on the record, so the only way to get this wrong
// is to not look at it.
function awardLabel(g: GrantEmbed | null | undefined): string | null {
  if (!g) return null;
  const range = formatAwardRange(g.award_range_min, g.award_range_max);
  if (range === "—") return null;
  return g.award_range_is_estimate ? `${range} est.` : range;
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
    .select("id, fit_score, decision, interested_at, sme_interested_at, sme_released_at, sent_at, pursuit_path, grants(id, title, funder, submission_deadline, award_range_min, award_range_max, award_range_is_estimate)")
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
  // The row shape everything downstream actually works with: CardRow plus the embedded
  // grant flattened to one object. Named so the derivations below can be typed against
  // it instead of against CardRow, which no longer describes them.
  type DashCard = (typeof cards)[number];
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
      // Deliberately pushes nothing: the pinned "Review matched grants" row already
      // carries this queue and its count, and a dynamic item saying the same thing would
      // render it twice. The BRANCH stays so the `else` below still only fires once review
      // is actually clear -- collapsing it would offer the portal invite mid-review.
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

  // Console presentation for the attention rows, keyed by the item id the pushes above
  // already set. Done as a decoration pass rather than inline at each push so the
  // WHAT (which items exist, and when) stays in one readable sequence and the HOW IT
  // LOOKS stays in one table -- nine call sites each carrying an icon and a tint is how
  // those two concerns drift apart.
  //
  // `tone` reuses the pipeline stage scale on purpose: an attention row about triage
  // and the pipeline's triage column should read as the same thing, not two palettes.
  // `pill` is set only where there is somewhere to go AND the work can start now.
  const ATTENTION_STYLE: Record<
    string,
    { icon: LucideIcon; tone: PipelineStageKey; pill?: boolean }
  > = {
    matching: { icon: Loader2, tone: "triage" },
    "run-matches": { icon: Play, tone: "triage" },
    "to-review": { icon: Layers, tone: "triage", pill: true },
    "invite-client": { icon: Mail, tone: "passed" },
    "connect-apis": { icon: Plug, tone: "client" },
    "grant-report-pending": { icon: Clock, tone: "client" },
    "next-step": { icon: MessageSquareText, tone: "passed" },
  };

  // The pill's LABEL is derived from the href, not stored beside the icon. It used to be
  // a static string ("Open Grant Alerts") in the table above while the href was computed
  // per-actor at the push site -- so for an account-managed client or a lead, whose review
  // gate is the roadmap list rather than the alerts swipe, the button named a destination
  // it did not go to. Two independent code paths keyed off the same id with nothing tying
  // them together. Reading the label off the href is what makes them unable to disagree.
  const pillLabel = (href: string) => (href === alertsHref ? "Open Grant Alerts" : "Open review");

  const consoleActionItems: DashActionItem[] = actionItems.map((it) => {
    const style = ATTENTION_STYLE[it.id];
    // The design gives each row a second line. The existing `tag` is that sentence, and
    // the onboarding step is appended when there is one -- so "step 3 of 3" moves off
    // the right-hand slot (now the affordance's) without being lost.
    const description =
      [it.tag, it.stage ? `step ${it.stage.step} of ${it.stage.total}` : null].filter(Boolean).join(" · ") || null;
    return {
      ...it,
      description,
      icon: style?.icon,
      tone: style?.tone,
      // A pill REQUIRES an href -- a filled button that navigates nowhere is the exact
      // thing this card is meant to stop. And a row with no href falls to "none", not
      // "blocked": these rows have no link for three different reasons, and only one of
      // them is a prerequisite. `run-matches` and `invite-client` are actioned by the
      // top-right control (their own description says so); `next-step` is a note from the
      // team; `grant-report-pending` on a managed client is a status readout. Defaulting
      // those to "Blocked" put that word next to a description reading "Use the button,
      // top right" -- a row arguing with itself.
      affordance: style?.pill && it.href
        ? { kind: "pill", label: pillLabel(it.href) }
        : it.href
          ? { kind: "chevron" }
          : { kind: "none" },
    };
  });

  // ALWAYS-PRESENT queue rows, above the dynamic items. They give the attention card a
  // floor height so the left column stops collapsing on a quiet client, and they answer
  // "is there anything waiting for me" without the answer depending on whether an action
  // item happened to be generated.
  //
  // Only queues that EXIST get a row. In-app messaging is deliberately absent: it is not
  // built (the portal still advertises it as coming soon), so a row for it would be a
  // permanently-zero count behind a permanently dead button -- the "Submitted" pipeline
  // stage and the "Soon" nav links over again. It gets a row the day it ships.
  const reviewHref = managed || isLead ? base : alertsHref;
  const intellEngineHref = `/clients/${client.id}/intellengine`;
  const pinnedRows: DashPinnedRow[] = [
    {
      id: "review-queue",
      title: "Review matched grants",
      description: managed || isLead
        ? "Snapshot review — clear the ones that don't apply"
        : "Triage before they reach the client's Grant Alerts",
      count: toReview,
      icon: Layers,
      tone: "triage",
      href: reviewHref,
      actionLabel: pillLabel(reviewHref),
    },
    {
      id: "proposals",
      title: "Grant proposals",
      description: "Drafts in progress in IntellEngine",
      count: drafts.length,
      icon: Sparkles,
      tone: "approved",
      href: intellEngineHref,
      actionLabel: "Open IntellEngine",
    },
  ];

  // See ClientDashboard's attentionNote prop: the design's line names Grant Alerts, which
  // is only where this card leads for a standard client. Managed clients and leads review
  // on the roadmap list, so they are told that instead.
  const attentionNote =
    managed || isLead ? "The review list opens from here only" : "Grant Alerts opens from here only";

  const subLine =
    [client.org_type?.replace(/_/g, " "), client.location_city, client.location_state].filter(Boolean).join(" · ") || null;

  // Everything still open. Passed is a closed decision, so it is out of both the Grant
  // Report rows and the deadline reads below -- though it IS still a pipeline column.
  const liveCards = cards.filter((c) => c.decision !== "passed");

  // The pipeline replaces the four stat tiles. Same rows the page already loaded, one
  // pure cascade over them -- see lib/clients/pipeline.ts for the five stages and how
  // each is derived.
  const pipeline = derivePipeline(cards);

  // The date in the pipeline header. The design reads "triage window closes {date}";
  // there is no triage-window field, and a placeholder date must never ship on a
  // surface staff quote to a client. So the slot carries the nearest REAL deadline
  // across this client's still-open grants, labelled for what it is. Passed cards are
  // excluded (a closed decision's deadline is not upcoming) and so are dates already
  // behind us -- an overdue date presented as the "next deadline" would be its own
  // small lie. Null when nothing qualifies, and the clause drops entirely.
  const nextDeadlineLabel =
    liveCards
      .map((c) => c.grant?.submission_deadline)
      .filter((d): d is string => Boolean(d) && (deadlineDaysLeft(d) ?? -1) >= 0)
      .sort()
      .map((d) => format(parseISO(d), "MMM d"))[0] ?? null;

  // Rail: the next three real deadlines, soonest first. Same source and same exclusions
  // as the header date above -- open cards only, nothing overdue -- so the two can never
  // tell different stories about which deadline is next. The stage label is read off the
  // pipeline's own stage list rather than re-derived, for the same reason.
  const DEADLINE_ROWS = 3;
  const stageLabel = new Map(pipeline.stages.map((s) => [s.key, s.label]));
  const deadlines: DashDeadline[] = liveCards
    .map((c) => ({ card: c, days: deadlineDaysLeft(c.grant?.submission_deadline) }))
    .filter((x): x is { card: DashCard; days: number } => x.days !== null && x.days >= 0)
    .sort((a, b) => a.days - b.days)
    .slice(0, DEADLINE_ROWS)
    .map(({ card, days }) => ({
      id: card.id,
      title: card.grant?.title || "Untitled opportunity",
      meta: [card.grant?.funder, stageLabel.get(stageOf(card))?.toLowerCase()].filter(Boolean).join(" · ") || null,
      days,
      href: `${base}/${card.id}`,
    }));

  // Grant Report card: the strongest live matches, highest fit first, then soonest
  // deadline as the tiebreak (among equal fits, the one with a clock on it is the one
  // to look at). Passed cards are excluded -- they are a closed decision, and the card
  // is about what is still open. Staff see every non-passed card including ones not
  // yet released to the client, which is exactly what their own roadmap list shows.
  const REPORT_ROWS = 3;
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
      // Console row extras.
      amount: awardLabel(c.grant),
      stage: stageOf(c),
      stageLabel: stageLabel.get(stageOf(c)) ?? null,
      days: deadlineDaysLeft(c.grant?.submission_deadline),
    }));

  // Header metrics. Definitions kept narrow and separately checkable rather than
  // clever: `open` is what still awaits a decision, `decided` is what has been
  // committed to. Passed is in neither -- it is a closed decision, and counting it as
  // "decided" would make the pair read as though most of the roster had been actioned.
  //
  // avgFit is the ONE legitimate decimal on this card. Per-row fit is a 1-3 ordinal and
  // stays an integer (the design shows values like "3.4", which are not representable
  // and are not reproduced); a mean ACROSS rows is a different quantity and is labelled
  // as an average. Null when there is nothing to average -- "0.0 avg fit" would read as
  // though everything scored zero.
  const reportMetrics = {
    open: liveCards.filter((c) => c.decision === "pending").length,
    decided: cards.filter((c) => c.decision === "approved").length,
    avgFit: liveCards.length
      ? (liveCards.reduce((n, c) => n + c.fit_score, 0) / liveCards.length).toFixed(1)
      : null,
  };

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
        hero={<GrantPipeline pipeline={pipeline} nextDeadlineLabel={nextDeadlineLabel} />}
        actionItems={consoleActionItems}
        pinnedRows={pinnedRows}
        activity={counts}
        report={{
          rows: reportRows,
          metrics: reportMetrics,
          total: liveCards.length,
          emptyNote: matchInProgress
            ? "Matching is running — opportunities will appear here as they are scored."
            : "No matches yet. Run grant matches to surface opportunities.",
        }}
        drafts={{
          list: drafts,
          emptyNote: "No proposals started yet. IntellEngine is where a matched grant becomes a draft.",
        }}
        // Pure read of the community_context already on the record -- no fetch here.
        community={buildCommunityView(client)}
        deadlines={deadlines}
        attentionNote={attentionNote}
        // The scorer moves INTO the rail. It used to sit under the hero as `staffTools`,
        // where it was the loudest thing on the page for a tool that is not daily-use;
        // the design makes it a compact rail card instead.
        scorer={isLead ? undefined : <CheckGrant clientId={client.id} clientName={client.name} />}
        bookingUrl={process.env.NEXT_PUBLIC_BOOKING_URL ?? null}
        matchNote={matchNote}
        />
      </div>
    </div>
  );
}
