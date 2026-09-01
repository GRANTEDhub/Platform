import Link from "next/link";
import { notFound } from "next/navigation";
import { format, parseISO } from "date-fns";
import { Clock, Layers, Loader2, Mail, MessageSquareText, Plug, Play, type LucideIcon } from "lucide-react";
import { requireUser } from "@/lib/auth";
import { GrantBotLauncher } from "@/components/grantbot/grantbot-launcher";
import { grantbotVisionEnabled } from "@/lib/grantbot/vision";
import { BLANK_CONVERSATION } from "@/lib/grantbot/wire";
import { createClient } from "@/lib/supabase/server";
import { AutoRefresh } from "@/components/ui/auto-refresh";
import { GenerateReportButton } from "@/components/clients/generate-report-button";
import { CheckGrant } from "@/components/clients/check-grant";
import { InviteClientButton } from "@/components/clients/invite-client-button";
import { ClientMasthead } from "@/components/clients/client-masthead";
import { stageOf, type PipelineStageKey } from "@/lib/clients/pipeline";
import { inviteClientToPortalAction } from "../actions";
import { ClientDashboard, type DashActionItem, type DashPinnedRow } from "@/components/clients/client-dashboard";
import { type DashReportRow } from "@/components/clients/client-grant-report-card";
import { type DashDraft } from "@/components/clients/client-draft-progress";
import { buildCommunityView } from "@/lib/clients/community";
import { deriveEnrichmentSteps } from "@/lib/clients/enrichment-status";
import { isUnconvertedLead } from "@/lib/leads/stage";
import { deadlineDaysLeft } from "@/lib/report/shape";
import { formatAwardRange } from "@/lib/grants/format";
import { rollUpClient, type PricedCard } from "@/lib/clients/dashboard-summary";
import { deriveAmbientNote } from "@/lib/clients/ambient-note";
import { deriveActivity } from "@/lib/clients/activity";
import { deriveBacklog, leftTriageAt } from "@/lib/clients/backlog";
import { type DraftNext } from "@/components/clients/client-draft-progress";
import type { Client, CardDecision, FactorScores, Grant, IntellEngineDraft, PursuitPath } from "@/types/database";

export const dynamic = "force-dynamic";

// The per-client dashboard — now the shared, actor-aware hub (Figma format). Staff
// view (isStaff) mounts here; the client portal mounts the same component (Phase 2).
// Staff-internal detail (contact / engagement / billing / portal access / repository
// / notes) lives on Profile management, not here. Ledger click-throughs are gone — grant
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
  // Per-factor sub-scores (#105). Null on cards scored before they shipped -- the
  // IntellEngine panel's rationale degrades to a shorter sentence rather than guessing.
  factor_scores: FactorScores | null;
  decision: CardDecision;
  decided_at: string | null;
  interested_at: string | null;
  sme_interested_at: string | null;
  sme_released_at: string | null;
  // Read by the pipeline derivation: the alert email physically went out.
  sent_at: string | null;
  // Also the pipeline's: null on an approved card means the decision is recorded but
  // the pursuit path is still open, which is the Approved stage rather than In pursuit.
  pursuit_path: PursuitPath | null;
  grant_id: string | null;
  grants: GrantEmbed | GrantEmbed[] | null;
};

// How long ago, in the masthead-adjacent "Updated 4h ago" shape. Deliberately coarse:
// the point is "is this list current", not the exact interval, and a minute-precise
// figure on a page that is not live-updating would be its own small lie.
function agoLabel(iso: string, now: number): string | null {
  const t = Date.parse(iso);
  if (!Number.isFinite(t) || t > now) return null;
  const mins = Math.floor((now - t) / 60_000);
  if (mins < 60) return mins <= 1 ? "just now" : `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

// Which factors read "strong", in the order a reader cares about them. The IntellEngine
// panel's waiting-state sentence is built from these rather than from a template, so it
// can only ever say something the engine actually scored.
const FACTOR_LABEL: { key: keyof FactorScores; label: string }[] = [
  { key: "eligibility", label: "eligibility" },
  { key: "geographic", label: "geography" },
  { key: "seat_role", label: "the seat" },
  { key: "mission", label: "mission fit" },
  { key: "program_history", label: "program history" },
  { key: "cost_share", label: "cost share" },
];

// One sentence for the waiting state: what already looks right about the closest
// candidate, and what approving it would unlock.
//
// It names ONLY factors the engine rated strong. With no factor scores on the card (they
// post-date #105) it degrades to the shorter half of the sentence rather than asserting
// anything about eligibility it cannot support -- which is the specific thing that must
// never be guessed at on a grant surface.
function waitingRationale(scores: FactorScores | null, days: number | null): string {
  const strong = scores
    ? FACTOR_LABEL.filter(({ key }) => scores[key]?.rating === "strong").map(({ label }) => label)
    : [];
  const clock = days !== null && days >= 0 ? ` ${days} ${days === 1 ? "day" : "days"} to the deadline.` : "";
  if (strong.length === 0) return `Highest fit of what is waiting. Approve it and IntellEngine can scope it.${clock}`;
  const list =
    strong.length === 1
      ? strong[0]
      : `${strong.slice(0, -1).join(", ")} and ${strong[strong.length - 1]}`;
  const verb = strong.length === 1 ? "scores" : "score";
  return `${list.charAt(0).toUpperCase()}${list.slice(1)} ${verb} strong. Approve it and IntellEngine can scope it.${clock}`;
}

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

export default async function ClientDashboardPage({
  params,
  searchParams,
}: {
  params: { id: string };
  // ?grantbot=<conversation id> (or any value) reopens the GrantBot panel on arrival — how the
  // full page collapses back to the corner without losing the thread.
  searchParams: { grantbot?: string };
}) {
  await requireUser();
  const supabase = createClient();

  const grantbotParam = searchParams.grantbot;
  // The full page's Collapse link names the conversation it was on, or BLANK_CONVERSATION when
  // that conversation had been started but never sent and so has no id to name. Blank is NOT the
  // same as absent: absent means "no preference, open the most recent thread", and treating an
  // unsent conversation that way dropped the reader into the previous one. ("1" carried the same
  // intent in the first cut of this link; still honoured so a tab opened before this change does
  // not land on the wrong thread.)
  const grantbotBlank = grantbotParam === BLANK_CONVERSATION || grantbotParam === "1";
  const grantbotConversationId = grantbotParam && !grantbotBlank ? grantbotParam : null;

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
    .select("id, fit_score, factor_scores, decision, decided_at, interested_at, sme_interested_at, sme_released_at, sent_at, pursuit_path, grant_id, grants(id, title, funder, submission_deadline, award_range_min, award_range_max, award_range_is_estimate)")
    .eq("client_id", params.id)
    .neq("card_type", "prospect");

  // When the engine first carded each (client, grant) pair. review_cards has no
  // created_at, so this is the only record of when a match APPEARED -- which is both the
  // Grant Report's "updated Nh ago" and the activity feed's "N new matches". Ascending,
  // so the first row seen for a grant is its earliest attempt: a min without a compare.
  const { data: attemptRows } = await supabase
    .from("match_attempts")
    .select("grant_id, created_at")
    .eq("client_id", params.id)
    .eq("outcome", "carded")
    .order("created_at", { ascending: true });

  // The client's proposals in flight (migration 0062). Staff read every draft for
  // this client under the staff RLS policy; ordered the same way the IntellEngine hub
  // orders them, so the dashboard card leads with the same draft the hub does.
  const { data: draftRows } = await supabase
    .from("intellengine_drafts")
    .select("id, card_id, title, status, content, updated_at")
    .eq("client_id", params.id)
    .order("updated_at", { ascending: false });

  const draftRecords = (draftRows ?? []) as Pick<
    IntellEngineDraft,
    "id" | "card_id" | "title" | "status" | "content" | "updated_at"
  >[];
  // content, not status: the panel's progress is derived from what the draft holds (0074).
  const drafts: DashDraft[] = draftRecords.map((d) => ({ id: d.id, title: d.title, content: d.content }));

  // grant_id -> ms of the first carded attempt for that pair.
  const firstCarded = new Map<string, string>();
  for (const a of (attemptRows ?? []) as { grant_id: string | null; created_at: string }[]) {
    if (!a.grant_id || firstCarded.has(a.grant_id)) continue;
    firstCarded.set(a.grant_id, a.created_at);
  }
  const now = Date.now();
  // Latest carded attempt = when this client's match list last changed.
  const lastCarded = ((attemptRows ?? []) as { created_at: string }[]).at(-1)?.created_at ?? null;
  const freshness = lastCarded ? agoLabel(lastCarded, now) : null;

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
  // The API-data view is a SECTION of Profile management ▸ Profile now, not its own
  // route/button.
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

  // The pipeline, now IN the masthead rather than a card under it. Same rows the page
  // already loaded, one pure cascade over them (lib/clients/pipeline.ts) plus the award
  // rollup per stage (lib/clients/dashboard-summary.ts -- read its note on why the money
  // is labelled as an estimated ceiling and never as expected receipts).
  const priced: PricedCard[] = cards.map((c) => ({
    decision: c.decision,
    interested_at: c.interested_at,
    sme_released_at: c.sme_released_at,
    sent_at: c.sent_at,
    pursuit_path: c.pursuit_path,
    awardMin: c.grant?.award_range_min ?? null,
    awardMax: c.grant?.award_range_max ?? null,
    awardIsEstimate: c.grant?.award_range_is_estimate ?? null,
  }));
  const book = rollUpClient(priced);
  const stageLabel = new Map(book.stages.map((s) => [s.key, s.label]));

  // The masthead's backlog sparkline. Reconstructed from timestamps this page already
  // has -- see lib/clients/backlog.ts, which reverses the earlier conclusion that a trend
  // needs a nightly snapshot table. It does for a general metric; it does not for THIS
  // one, because both edges of "untriaged" are already recorded.
  const backlog = deriveBacklog(
    cards.map((c) => ({
      enteredAt: c.grant_id ? (firstCarded.get(c.grant_id) ?? null) : null,
      leftAt: leftTriageAt(c),
    })),
    now,
  );

  // The date in the pipeline header. The design reads "triage window closes {date}";
  // there is no triage-window field, and a placeholder date must never ship on a
  // surface staff quote to a client. So the slot carries the nearest REAL deadline
  // across this client's still-open grants, labelled for what it is. Passed cards are
  // excluded (a closed decision's deadline is not upcoming) and so are dates already
  // behind us -- an overdue date presented as the "next deadline" would be its own
  // small lie. Null when nothing qualifies, and the clause drops entirely.
  const nextDeadline =
    liveCards
      .map((c) => c.grant?.submission_deadline)
      .filter((d): d is string => Boolean(d) && (deadlineDaysLeft(d) ?? -1) >= 0)
      .sort()[0] ?? null;
  const nextDeadlineLabel = nextDeadline ? format(parseISO(nextDeadline), "MMM d") : null;
  const nextDeadlineDays = deadlineDaysLeft(nextDeadline);

  // The upcoming-deadlines rail card is GONE -- the design drops it, and every deadline
  // it carried is already on a Grant Report row with a day count beside it. The rail slot
  // it held goes to the activity feed, which is also what makes the two columns end level.

  // The IntellEngine observation at the foot of the attention card. Deterministic rules
  // over records this page already has -- see lib/clients/ambient-note.ts for why it is
  // not model-authored, and for the two findings it can and cannot make. Null is the
  // expected common case and renders nothing at all.
  const ambient = deriveAmbientNote({
    cards: liveCards.map((c) => ({
      id: c.id,
      stage: stageOf(c),
      funder: c.grant?.funder ?? null,
      deadlineDays: deadlineDaysLeft(c.grant?.submission_deadline),
    })),
    hasDraft: drafts.length > 0,
    triageHref: reviewHref,
    intellEngineHref,
    // Pinned rows carrying a count, plus the dynamic items -- the same definition the
    // attention card's own badge uses, so "the card already has four things on it" means
    // the same thing in both places.
    otherRows: pinnedRows.filter((r) => r.count > 0).length + consoleActionItems.length,
  });

  // What the IntellEngine panel points at when no draft is in flight. Two states, and
  // the panel is never empty in either -- see DraftNext in the component.
  const draftedCardIds = new Set(draftRecords.map((d) => d.card_id).filter(Boolean));

  // READY: approved, nobody started it, nearest deadline first. Undated sorts last --
  // "no deadline" is the absence of a clock, not urgency.
  const readyQueue = cards
    .filter((c) => c.decision === "approved" && !draftedCardIds.has(c.id))
    .map((c) => ({ card: c, days: deadlineDaysLeft(c.grant?.submission_deadline) }))
    .sort((a, b) => (a.days ?? Number.POSITIVE_INFINITY) - (b.days ?? Number.POSITIVE_INFINITY));

  const draftNext: DraftNext | null = (() => {
    const ready = readyQueue[0];
    if (ready) {
      const { card, days } = ready;
      const sinceApproved =
        card.decided_at !== null ? Math.max(0, Math.floor((now - Date.parse(card.decided_at)) / 86_400_000)) : null;
      // Every clause drops when its fact is missing rather than being guessed at, so the
      // sentence gets shorter instead of getting invented. The closing line is only true
      // when this really is the only unstarted approval, so it is only said then.
      const parts: string[] = [];
      if (sinceApproved !== null) {
        parts.push(
          `Approved ${sinceApproved === 0 ? "today" : `${sinceApproved} ${sinceApproved === 1 ? "day" : "days"} ago`}`,
        );
      }
      if (days !== null && days >= 0) parts.push(`${days} ${days === 1 ? "day" : "days"} left on the clock`);
      else if (days !== null) parts.push("the deadline has already passed");
      const lead = parts.length > 0 ? `${parts.join(" with ")}.` : "Approved and not yet scoped.";
      const tail =
        readyQueue.length === 1
          ? " It is the only approved match with nothing drafted."
          : ` ${readyQueue.length - 1} other${readyQueue.length === 2 ? "" : "s"} are waiting too.`;
      return {
        kind: "ready",
        pick: {
          title: card.grant?.title || "Untitled opportunity",
          meta: [card.grant?.funder, awardLabel(card.grant), "approved, never started"].filter(Boolean).join(" \u00b7 "),
          rationale: lead + tail,
          href: `${intellEngineHref}?start=${card.id}`,
        },
      };
    }

    // WAITING: nothing is approved, so the blocker is upstream and the panel says so.
    // It still shows the closest candidate -- knowing what an approval would unlock is
    // the point, and hiding it would make the card sit blank for exactly the clients who
    // most need pushing.
    const untriaged = cards.filter((c) => c.decision !== "passed" && c.interested_at === null).length;
    const closest = cards
      .filter((c) => c.decision !== "passed" && c.decision !== "approved")
      .map((c) => ({ card: c, days: deadlineDaysLeft(c.grant?.submission_deadline) }))
      .sort(
        (a, b) =>
          b.card.fit_score - a.card.fit_score ||
          (a.days ?? Number.POSITIVE_INFINITY) - (b.days ?? Number.POSITIVE_INFINITY),
      )[0];

    if (!closest) return null;

    return {
      kind: "waiting",
      unassessed: untriaged,
      reviewHref,
      pick: {
        title: closest.card.grant?.title || "Untitled opportunity",
        meta: [closest.card.grant?.funder, awardLabel(closest.card.grant), `fit ${closest.card.fit_score}/3`]
          .filter(Boolean)
          .join(" \u00b7 "),
        rationale: waitingRationale(closest.card.factor_scores, closest.days),
        href: `${intellEngineHref}?start=${closest.card.id}`,
      },
    };
  })();

  // Rail: what has moved lately. NOT "since you were last here" -- see
  // lib/clients/activity.ts for why that needs a migration and what is derived instead.
  const events = deriveActivity({
    carded: cards.map((c) => (c.grant_id ? firstCarded.get(c.grant_id) : null)).filter((t): t is string => !!t),
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
  });

  // Grant Report card: what is PENDING OUR REVIEW, highest fit first, then soonest
  // deadline as the tiebreak (among equal fits, the one with a clock on it is the one to
  // look at).
  //
  // TRIAGE ONLY, which is narrower than the card used to be. It listed every non-passed
  // match, so a grant already released to the client kept sitting at the top of our own
  // to-do card -- correctly labelled "with client", and still the first thing on the
  // dashboard, which is the opposite of what a queue is for. stageOf is the same cascade
  // the roadmap list and the pipeline bar use, so "ours" here means exactly what it means
  // everywhere else: not passed, not approved, and not yet alerted or marked interested.
  const REPORT_ROWS = 3;
  const pendingOurReview = liveCards.filter((c) => stageOf(c) === "triage");
  const reportRows: DashReportRow[] = [...pendingOurReview]
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
    freshness,
  };

  // "Client since" only when there IS a contract start. Otherwise this reports when the
  // record was created and says so -- those are different facts, and labelling a
  // created_at as "client since" would overstate the relationship by however long the
  // record sat unsigned.
  const since = client.contract_start
    ? `Client since ${format(parseISO(client.contract_start), "MMM yyyy")}`
    : `Added ${format(parseISO(client.created_at), "MMM yyyy")}`;
  const contextMeta =
    [
      client.org_type?.replace(/_/g, " "),
      [client.location_city, client.location_state].filter(Boolean).join(", ") || null,
      since,
    ]
      .filter(Boolean)
      .join(" · ") || null;

  // No visible banner: the action item carries the spinner and the message now, and
  // saying it twice on one screen read as clutter. AutoRefresh still mounts, because
  // results appearing without a manual reload is behaviour, not decoration.
  const matchNote = matchInProgress ? <AutoRefresh enabled /> : null;

  // On ink now, so both controls are reversed out: Profile management as an outlined ghost,
  // Refresh matches as the one white-filled primary on the band.
  //
  // TWO CONTROLS, and that is the whole row. It had grown to five as each brick landed --
  // Edit profile, Documents, Context pack, GrantBot, Refresh matches -- which flattened a
  // hierarchy that is not flat: three of them were the same job (what the platform holds
  // about this org) reached three ways, and one was a conversation. The three are tabs of
  // the Profile-management hub now, and GrantBot is not a destination at all.
  const actions = (
    <>
      <Link
        href={editHref}
        className="inline-flex h-8 items-center rounded-pill border border-white/20 px-[14px] text-[13px] font-medium text-white/[0.85] transition-colors hover:border-white/40 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-orange/60 focus-visible:ring-offset-2 focus-visible:ring-offset-brand-chrome"
      >
        Profile management
      </Link>
      <GenerateReportButton
        clientId={client.id}
        inProgress={matchInProgress}
        confirmRerun={confirmRerun}
        tone="ink"
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
    <>
    <ClientDashboard
      name={client.name}
      subLine={subLine}
      isStaff
      roadmapHref={base}
      intellEngineHref={intellEngineHref}
      // The masthead REPLACES both the white identity strip and the pipeline card. See
      // components/clients/client-masthead.tsx: a client's funnel is not a card on the
      // page, it is the summary of the page, and collapsing the two buys back the ~90px
      // that makes 1440x900 fit without scrolling.
      hero={
        <ClientMasthead
          name={client.name}
          meta={contextMeta}
          statusLabel={isLead ? "prospect" : client.status}
          book={book}
          decided={reportMetrics.decided}
          nextDeadlineDays={nextDeadlineDays}
          backlog={backlog}
          nextDeadlineLabel={nextDeadlineLabel}
          backHref="/clients"
          backLabel="Portfolio"
          actions={actions}
        />
      }
      actionItems={consoleActionItems}
      pinnedRows={pinnedRows}
      report={{
        rows: reportRows,
        metrics: reportMetrics,
        total: liveCards.length,
        // The rows are the triage subset now, so the band says so rather than describing a
        // sort order over a list it no longer shows in full.
        rowsLabel: "Pending your review",
        // THREE DIFFERENT EMPTIES, because they call for three different next moves. Now
        // that the rows are triage-only, "nothing left for us to review" is a common and
        // GOOD state -- and reporting it as "no matches yet, run grant matches" would send
        // someone to re-run a scorer on a client whose whole book is already with them.
        emptyNote: matchInProgress
          ? "Matching is running — opportunities will appear here as they are scored."
          : liveCards.length > 0
            ? "Nothing left for you to review — every open match is with the client or approved. Open the report to see them."
            : "No matches yet. Run grant matches to surface opportunities.",
      }}
      drafts={{
        list: drafts,
        emptyNote: "No proposals started yet. IntellEngine is where a matched grant becomes a draft.",
      }}
      draftNext={draftNext}
      // Pure read of the community_context already on the record -- no fetch here.
      community={buildCommunityView(client)}
      events={events}
      ambient={ambient}
      // The oversized figure bled off the body's bottom-right corner: the unassessed
      // count, at 3% ink. Nothing to bleed when there is nothing waiting.
      ghost={book.stages.find((s) => s.key === "triage")?.count ?? null}
      attentionNote={attentionNote}
      // The scorer sits in the rail -- it used to be the loudest thing on the page for a
      // tool that is not daily-use.
      scorer={isLead ? undefined : <CheckGrant clientId={client.id} clientName={client.name} />}
      matchNote={matchNote}
    />
    {/* OUTSIDE ClientDashboard, deliberately. That component is the shared actor-aware hub the
        client portal will mount too (Phase 2), and GrantBot's context pack carries internal staff
        notes -- so the launcher hangs off this staff-only route instead, where the portal cannot
        inherit it by rendering the same component. Fixed-position, so it needs no place in the
        layout. Nothing is fetched until it is opened. */}
    <GrantBotLauncher
      clientId={client.id}
      clientName={client.name}
      startOpen={grantbotParam !== undefined}
      startConversationId={grantbotConversationId}
      startBlank={grantbotBlank}
      visionEnabled={grantbotVisionEnabled()}
    />
    </>
  );
}
