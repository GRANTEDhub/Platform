import Link from "next/link";
import {
  CalendarPlus,
  ChevronRight,
  LifeBuoy,
  Loader2,
  MessageSquare,
  Sparkles,
  Target,
  type LucideIcon,
} from "lucide-react";
import { Card } from "@/components/ui/card";
import { ClientMatchChart } from "@/components/clients/client-match-chart";
import {
  ClientGrantReportCard,
  type DashReportRow,
  type DashReportMetrics,
} from "@/components/clients/client-grant-report-card";
import { ClientDraftProgress, type DashDraft } from "@/components/clients/client-draft-progress";
import { ClientCommunityContext } from "@/components/clients/client-community-context";
import { UpcomingDeadlines, type DashDeadline } from "@/components/clients/upcoming-deadlines";
import type { CommunityView } from "@/lib/clients/community";
import { HeroBand } from "@/components/layout/hero-band";
import { BRAND, STAGE } from "@/lib/brand";
import type { PipelineStageKey } from "@/lib/clients/pipeline";

// The shared, actor-aware client dashboard — the per-client hub. Staff open it via
// Portfolio → client; the client lands here on login (Phase 2). Staff-only controls
// (Edit profile, Refresh matches) render only when isStaff. Staff-internal detail lives
// on Edit profile, not here.
//
// TWO BODY LAYOUTS, and the fork is deliberate. The approved design
// (design/dashboard/) is the STAFF console: a full-bleed two-column body at 34px
// gutters. app/portal/page.tsx mounts this same component with isStaff={false}, so the
// client portal renders from it too — and the design says nothing about the portal.
// Applying the console layout to both would silently restyle a client-facing surface
// and delete cards (the activity chart, the shortcut tiles) that only the portal still
// relies on. So `isStaff` picks the body: PortalBody is unchanged, ConsoleBody is the
// design. Converging them is a deliberate follow-up, not a side effect of this pass.

const SUPPORT = "support@grantedco.com";

export interface DashStat {
  label: string;
  value: string;
  sub?: string | null;
  icon: LucideIcon;
  accent?: boolean;
}

// The trailing control on an attention row, which encodes urgency rather than repeating
// it in words: a filled pill for work you can start now, a chevron for something to
// look at, the flat word "Blocked" for what is waiting on a prerequisite. A blocked row
// gets NO control at all — an affordance you cannot act on is the failure this
// dashboard keeps being cleaned up for.
export type DashAffordance =
  | { kind: "pill"; label: string }
  | { kind: "chevron" }
  | { kind: "blocked" };

export interface DashActionItem {
  id: string;
  title: string;
  tag?: string | null;
  date?: string | null;
  priority?: "high" | "medium" | null;
  href?: string | null;
  // Live work: renders a spinner + label on the right instead of a static chip, so
  // "something is running" lives ON the item rather than in a separate banner that
  // repeats it.
  busy?: boolean;
  // Where this sits in the onboarding sequence. A more useful right-hand slot than a
  // priority flag: it says how far along the record is, which is the question the
  // sequence exists to answer. Priorities are not a concept we have defined yet.
  stage?: { step: number; total: number } | null;
  // Console-only presentation. The portal's ActionRow ignores all three.
  description?: string | null;
  icon?: LucideIcon;
  // Which stage tint the row's icon tile carries. Reuses the pipeline scale so an
  // attention row and its pipeline column read as the same thing.
  tone?: PipelineStageKey;
  affordance?: DashAffordance;
}

export function ClientDashboard({
  name,
  subLine,
  isStaff,
  roadmapHref,
  intellEngineHref,
  hero,
  stats,
  actionItems,
  activity,
  report,
  drafts,
  community,
  deadlines,
  scorer,
  bookingUrl,
  editHref,
  refresh,
  matchNote,
}: {
  name: string;
  subLine: string | null;
  isStaff: boolean;
  roadmapHref: string;
  // Client-only: entry point into the self-serve AI proposal-drafting flow
  // (IntellEngine). Renders a shortcut tile only when provided (client portal
  // passes it; the staff dashboard doesn't).
  intellEngineHref?: string;
  // Replaces the HeroBand + stat-tile block entirely when provided. The staff console
  // passes the grant pipeline here; the client portal passes nothing and keeps the hero.
  hero?: React.ReactNode;
  // Optional because a `hero` replaces them. Required-but-ignored would have meant the
  // staff page computing four tiles nothing renders.
  stats?: DashStat[];
  actionItems: DashActionItem[];
  activity: { pending: number; approved: number; passed: number };
  // Left-column cards. Both are optional, and when one is absent its old shortcut
  // tile renders in the bottom row instead -- so a caller that passes neither gets
  // exactly the previous dashboard rather than a gap where a card should be.
  report?: { rows: DashReportRow[]; total: number; emptyNote: string; metrics?: DashReportMetrics };
  drafts?: { list: DashDraft[]; emptyNote: string };
  // Rail: community need-context read from client_profile.community_context.
  community?: CommunityView;
  // Rail, console-only: the next three real submission deadlines.
  deadlines?: DashDeadline[];
  // Rail, console-only: the grant scorer. Passed as a node because it is a client
  // component with its own state and the console only needs to place it.
  scorer?: React.ReactNode;
  bookingUrl: string | null;
  // Staff-only: Edit profile.
  editHref?: string | null;
  refresh?: React.ReactNode; // staff-only refresh control
  matchNote?: React.ReactNode; // staff-only in-progress indicator
}) {
  const scheduleHref = bookingUrl || `mailto:${SUPPORT}?subject=Schedule%20a%20strategy%20call`;

  // Console: full-bleed 34px gutters and 20px vertical, continuous with the context bar
  // above it. Portal: the centred max-w-7xl column it has always used.
  if (isStaff) {
    return (
      <div className="px-[34px] py-[20px]">
        {hero}
        {matchNote}
        <ConsoleBody
          actionItems={actionItems}
          report={report}
          drafts={drafts}
          community={community}
          deadlines={deadlines}
          scorer={scorer}
          roadmapHref={roadmapHref}
          intellEngineHref={intellEngineHref}
        />
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-7xl px-8 py-8">
      {hero ?? (
        <HeroBand
          title={name}
          subtitle={subLine ?? undefined}
          right={
            editHref || refresh ? (
              <div className="flex items-center gap-3">
                {editHref && (
                  <Link
                    href={editHref}
                    className="rounded-full border border-white/25 bg-white/10 px-4 py-2 text-sm font-medium text-white transition hover:bg-white/20"
                  >
                    Edit profile
                  </Link>
                )}
                {refresh}
              </div>
            ) : undefined
          }
          stats={(stats ?? []).map((s) => ({ value: s.value, label: s.label, sub: s.sub, accent: s.accent }))}
        />
      )}
      <PortalBody
        actionItems={actionItems}
        activity={activity}
        report={report}
        drafts={drafts}
        community={community}
        roadmapHref={roadmapHref}
        intellEngineHref={intellEngineHref}
        scheduleHref={scheduleHref}
      />
    </div>
  );
}

// ── Console body — the approved design ──────────────────────────────────────
//
// grid-template-columns: 1fr 318px, gap 16px. The left column is everything with a next
// action attached, read top to bottom; the rail is standing context you consult rather
// than act on. The two are within ~10px of each other in height BY DESIGN at 1440×900,
// so the page needs no scroll — if you change padding in either, re-check they still end
// level. The geography card's 76px image is load-bearing for that.
function ConsoleBody({
  actionItems,
  report,
  drafts,
  community,
  deadlines,
  scorer,
  roadmapHref,
  intellEngineHref,
}: {
  actionItems: DashActionItem[];
  report?: { rows: DashReportRow[]; total: number; emptyNote: string; metrics?: DashReportMetrics };
  drafts?: { list: DashDraft[]; emptyNote: string };
  community?: CommunityView;
  deadlines?: DashDeadline[];
  scorer?: React.ReactNode;
  roadmapHref: string;
  intellEngineHref?: string;
}) {
  return (
    <div className="mt-4 grid gap-4 xl:grid-cols-[1fr_318px] xl:items-start">
      <div className="flex flex-col gap-4">
        <AttentionCard items={actionItems} />

        {/* Side by side, equal width, equal height. IntellEngine is the shorter of the
            two by content: it stretches, its content stays top-aligned, and the slack
            falls to the bottom of the panel rather than centring it. */}
        <div className="grid gap-4 lg:grid-cols-2 lg:items-stretch">
          {report && (
            <ClientGrantReportCard
              variant="console"
              rows={report.rows}
              total={report.total}
              reportHref={roadmapHref}
              emptyNote={report.emptyNote}
              metrics={report.metrics}
            />
          )}
          {drafts && intellEngineHref && (
            <ClientDraftProgress
              variant="console"
              drafts={drafts.list}
              intellEngineHref={intellEngineHref}
              emptyNote={drafts.emptyNote}
            />
          )}
        </div>
      </div>

      {/* Rail, in the design's order: the scorer (a tool), then deadlines (a clock),
          then geography (standing evidence). */}
      <div className="flex flex-col gap-4">
        {scorer}
        {deadlines && deadlines.length > 0 && <UpcomingDeadlines deadlines={deadlines} />}
        {community && <ClientCommunityContext view={community} />}
      </div>
    </div>
  );
}

// "Needs your attention" — a tinted-header card whose rows encode urgency in their
// trailing control. THE CARD NEVER DISAPPEARS: when the queue clears it keeps its frame
// and shows a caught-up row instead. A card that vanishes makes the page collapse to a
// different shape, which is the instability this redesign exists to remove.
function AttentionCard({ items }: { items: DashActionItem[] }) {
  return (
    <section className="overflow-hidden rounded-2xl bg-white shadow-card">
      <div
        className="flex items-center gap-2.5 border-b px-5 py-3"
        style={{ backgroundColor: STAGE.triage.tint, borderColor: "rgba(228,118,31,0.14)" }}
      >
        <h2 className="font-serif text-base font-bold text-brand-navy">Needs your attention</h2>
        {items.length > 0 ? (
          <span className="rounded-full bg-brand-orange px-2 py-0.5 text-[11px] font-bold leading-[1.4] tabular-nums text-white">
            {items.length}
          </span>
        ) : (
          <span
            aria-hidden="true"
            className="h-2 w-2 rounded-full"
            style={{ backgroundColor: STAGE.pursuit.color }}
          />
        )}
        <span className="ml-auto text-[11.5px] text-ink-subtle">Grant Alerts opens from here only</span>
      </div>

      {items.length === 0 ? (
        <div className="px-5 py-6 text-center">
          <p className="text-sm font-semibold text-brand-navy">You&apos;re caught up</p>
          <p className="mt-1 text-xs text-ink-subtle">New matches land here as grants are scored.</p>
        </div>
      ) : (
        <ul>
          {items.map((it, i) => (
            <AttentionRow key={it.id} item={it} last={i === items.length - 1} />
          ))}
        </ul>
      )}
    </section>
  );
}

function AttentionRow({ item, last }: { item: DashActionItem; last: boolean }) {
  const Icon = item.icon;
  const tone = item.tone ?? "triage";
  const affordance = item.affordance ?? (item.href ? { kind: "chevron" as const } : { kind: "blocked" as const });

  const row = (
    <div className={`flex items-center gap-[13px] px-5 py-3 ${last ? "" : "border-b border-hairline"}`}>
      {Icon && (
        <span
          aria-hidden="true"
          className="flex h-[30px] w-[30px] shrink-0 items-center justify-center rounded-pill"
          style={{ backgroundColor: STAGE[tone].tint }}
        >
          <Icon
            className="h-[15px] w-[15px]"
            // stage-client's raw colour fails contrast, so its text companion is used
            // for the glyph — the same rule the pipeline dots follow.
            style={{ color: tone === "client" ? STAGE.client.text : STAGE[tone].color }}
          />
        </span>
      )}
      <div className="min-w-0 flex-1">
        <p className="text-sm font-semibold text-brand-navy">{item.title}</p>
        {item.description && <p className="mt-0.5 text-xs text-ink-subtle">{item.description}</p>}
      </div>
      {item.busy ? (
        <span className="inline-flex shrink-0 items-center gap-1.5 text-xs font-medium text-brand-orange">
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
          In progress
        </span>
      ) : affordance.kind === "pill" ? (
        <span className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-pill bg-brand-orange px-3.5 text-[12.5px] font-semibold text-white">
          {affordance.label}
          <ChevronRight className="h-3.5 w-3.5" />
        </span>
      ) : affordance.kind === "chevron" ? (
        <ChevronRight className="h-4 w-4 shrink-0 text-ink-faint" />
      ) : (
        <span className="shrink-0 text-xs font-medium text-ink-subtle">Blocked</span>
      )}
    </div>
  );

  return <li>{item.href ? <Link href={item.href} className="block hover:bg-page/60">{row}</Link> : row}</li>;
}

// ── Portal body — unchanged ─────────────────────────────────────────────────
// Byte-for-byte the layout the client portal has been shipping. It is separated out
// rather than shared so that console work cannot alter a client-facing surface by
// accident; see the note at the top of the file.
function PortalBody({
  actionItems,
  activity,
  report,
  drafts,
  community,
  roadmapHref,
  intellEngineHref,
  scheduleHref,
}: {
  actionItems: DashActionItem[];
  activity: { pending: number; approved: number; passed: number };
  report?: { rows: DashReportRow[]; total: number; emptyNote: string; metrics?: DashReportMetrics };
  drafts?: { list: DashDraft[]; emptyNote: string };
  community?: CommunityView;
  roadmapHref: string;
  intellEngineHref?: string;
  scheduleHref: string;
}) {
  return (
    <>
      <div className="mt-8 grid gap-6 lg:grid-cols-3 lg:items-start">
        <div className="space-y-6 lg:col-span-2">
          <Card className="p-6 shadow-card sm:p-7">
            <h2 className="font-serif text-[20px] font-semibold text-brand-navy">Needs attention</h2>
            {actionItems.length === 0 ? (
              <p className="mt-4 text-sm text-muted-foreground">Nothing needs your attention right now.</p>
            ) : (
              <ul className="mt-4 space-y-2">
                {actionItems.map((it) => (
                  <ActionRow key={it.id} item={it} />
                ))}
              </ul>
            )}
          </Card>

          {report && (
            <ClientGrantReportCard
              rows={report.rows}
              total={report.total}
              reportHref={roadmapHref}
              emptyNote={report.emptyNote}
            />
          )}

          {drafts && intellEngineHref && (
            <ClientDraftProgress
              drafts={drafts.list}
              intellEngineHref={intellEngineHref}
              emptyNote={drafts.emptyNote}
            />
          )}
        </div>

        <div className="space-y-6">
          {community && <ClientCommunityContext view={community} />}

          <Card className="p-6 shadow-card sm:p-7">
            <h2 className="font-serif text-[20px] font-semibold text-brand-navy">Grant activity</h2>
            <div className="mt-4">
              <ClientMatchChart
                data={[
                  { label: "In review", count: activity.pending, color: BRAND.slate },
                  { label: "Pursuing", count: activity.approved, color: BRAND.orange },
                  { label: "Passed", count: activity.passed, color: BRAND.taupe },
                ]}
              />
            </div>
          </Card>
        </div>
      </div>

      <div className="mt-6 grid grid-cols-2 gap-4 lg:grid-cols-4">
        {!report && (
          <QuickAction featured href={roadmapHref} icon={Target} title="Grant Report" sub="Review your matched opportunities" />
        )}
        {!drafts && intellEngineHref && (
          <QuickAction href={intellEngineHref} icon={Sparkles} title="IntellEngine" sub="Draft a proposal — AI assistance coming soon" />
        )}
        <QuickAction external href={scheduleHref} icon={CalendarPlus} title="Schedule with an advisor" sub="Book a grant strategy call" />
        <QuickAction external href={`mailto:${SUPPORT}?subject=Question%20for%20my%20GRANTED%20team`} icon={MessageSquare} title="Message your team" sub="In-app messaging — coming soon" />
        <QuickAction external href={`mailto:${SUPPORT}?subject=Help`} icon={LifeBuoy} title="Help" sub="FAQ & support" />
      </div>
    </>
  );
}

// Each item gets its OWN bordered box: text left, status right.
//
// The right slot deliberately does NOT show a priority flag -- priorities are not a
// concept we have defined, so "High" on everything was decoration pretending to be
// information. It carries, in order of preference: live progress (spinner), the
// onboarding stage, a date, or an open affordance for a navigable item.
function ActionRow({ item }: { item: DashActionItem }) {
  const body = (
    <div className="flex items-center justify-between gap-4 rounded-md bg-white px-4 py-3 ring-1 ring-brand-navy/[0.08] transition-shadow hover:shadow-card">
      <div className="min-w-0">
        <p className="text-sm font-medium text-brand-navy">{item.title}</p>
        {item.tag && (
          <span className="mt-1 inline-block rounded-full bg-brand-navy/[0.06] px-2.5 py-0.5 text-[11px] font-medium text-brand-navy">
            {item.tag}
          </span>
        )}
      </div>
      <div className="flex shrink-0 items-center gap-2 text-right">
        {item.busy ? (
          <span className="inline-flex items-center gap-1.5 text-xs font-medium text-brand-orange">
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
            In progress
          </span>
        ) : item.stage ? (
          <span className="text-xs font-medium text-muted-foreground">
            Step {item.stage.step} of {item.stage.total}
          </span>
        ) : item.date ? (
          <span className="text-xs text-muted-foreground">{item.date}</span>
        ) : item.href ? (
          <span aria-hidden="true" className="text-sm text-brand-orange">
            →
          </span>
        ) : null}
      </div>
    </div>
  );
  return <li>{item.href ? <Link href={item.href} className="block">{body}</Link> : body}</li>;
}

function QuickAction({
  href,
  icon: Icon,
  title,
  sub,
  featured,
  external,
}: {
  href: string;
  icon: LucideIcon;
  title: string;
  sub: string;
  featured?: boolean;
  external?: boolean;
}) {
  const cls = `flex flex-col gap-2 rounded-2xl p-5 shadow-card transition ${
    featured ? "bg-brand-navy text-white" : "border border-brand-navy/[0.08] bg-white text-brand-navy hover:border-brand-navy/20"
  }`;
  const inner = (
    <>
      <Icon className={`h-6 w-6 ${featured ? "text-brand-orange" : "text-brand-navy"}`} />
      <span className="mt-1 text-[15px] font-semibold">{title}</span>
      <span className={`text-[12.5px] ${featured ? "text-white/70" : "text-muted-foreground"}`}>{sub}</span>
    </>
  );
  return external ? (
    <a href={href} target="_blank" rel="noopener noreferrer" className={cls}>
      {inner}
    </a>
  ) : (
    <Link href={href} className={cls}>
      {inner}
    </Link>
  );
}
