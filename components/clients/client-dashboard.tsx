import Link from "next/link";
import { CalendarPlus, LifeBuoy, Loader2, MessageSquare, Sparkles, Target, type LucideIcon } from "lucide-react";
import { Card } from "@/components/ui/card";
import { ClientMatchChart } from "@/components/clients/client-match-chart";
import { ClientGrantReportCard, type DashReportRow } from "@/components/clients/client-grant-report-card";
import { ClientDraftProgress, type DashDraft } from "@/components/clients/client-draft-progress";
import { ClientCommunityContext } from "@/components/clients/client-community-context";
import type { CommunityView } from "@/lib/clients/community";
import { HeroBand } from "@/components/layout/hero-band";
import { BRAND } from "@/lib/brand";

// The shared, actor-aware client dashboard — the per-client hub. Staff open it via
// Portfolio → client; the client lands here on login (Phase 2). One surface: the
// body is identical for both, and staff-only controls (Edit profile, Refresh
// matches) render only when isStaff. Format mirrors the client Figma; content is
// GRANTED's real data. Staff-internal detail lives on Edit profile, not here.

const SUPPORT = "support@grantedco.com";

export interface DashStat {
  label: string;
  value: string;
  sub?: string | null;
  icon: LucideIcon;
  accent?: boolean;
}

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
  bookingUrl,
  editHref,
  refresh,
  matchNote,
  staffTools,
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
  // passes the grant pipeline here; the client portal passes nothing and keeps the
  // hero. Two audiences, and the pipeline speaks in internal terms ("GRANTED
  // Review"), so this is a genuine fork rather than a style toggle -- but it stays ONE
  // component so the action items, activity chart and shortcuts can't drift apart.
  hero?: React.ReactNode;
  // Optional because a `hero` replaces them. Required-but-ignored would have meant the
  // staff page computing four tiles nothing renders.
  stats?: DashStat[];
  actionItems: DashActionItem[];
  activity: { pending: number; approved: number; passed: number };
  // Left-column cards. Both are optional, and when one is absent its old shortcut
  // tile renders in the bottom row instead -- so a caller that passes neither gets
  // exactly the previous dashboard rather than a gap where a card should be.
  report?: { rows: DashReportRow[]; total: number; emptyNote: string };
  drafts?: { list: DashDraft[]; emptyNote: string };
  // Rail: community need-context read from client_profile.community_context. Optional
  // for the same reason as the two above -- absent means the rail simply carries Grant
  // activity alone, which is what it did before.
  community?: CommunityView;
  bookingUrl: string | null;
  // Staff-only: Edit profile. The API-data view used to sit beside it as a second
  // button; it is a SECTION of Edit profile now (?section=api), so the hero carries one
  // door into the profile instead of two.
  editHref?: string | null;
  refresh?: React.ReactNode; // staff-only refresh control
  matchNote?: React.ReactNode; // staff-only in-progress indicator
  staffTools?: React.ReactNode; // staff-only tools (e.g. "Check a grant"), below the hero
}) {
  const scheduleHref = bookingUrl || `mailto:${SUPPORT}?subject=Schedule%20a%20strategy%20call`;
  return (
    <div className="mx-auto max-w-7xl px-8 py-8">
      {hero ?? (
        <HeroBand
          title={name}
          subtitle={subLine ?? undefined}
          right={
            isStaff && (editHref || refresh) ? (
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
      {isStaff && matchNote}
      {isStaff && staffTools}

      {/* Main grid: a WORK column and a CONTEXT rail.

          The split is by role, not by size. The left column is everything with a next
          action attached -- what needs attention, what was matched, what is being
          drafted -- read top to bottom. The rail is standing context you consult
          rather than act on. That is why the report and draft cards moved out of the
          bottom shortcut row and into the column: they carry real state now, and
          state belongs in the reading order, not in a row of doors. */}
      <div className="mt-8 grid gap-6 lg:grid-cols-3 lg:items-start">
        <div className="space-y-6 lg:col-span-2">
          <Card className="p-6 shadow-grounded sm:p-7">
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

        {/* Context rail. Community context leads: its map tile is the rail's visual
            anchor and it answers "where is this org" -- the standing question the rest
            of the rail is read against. Grant activity follows, because it moves. */}
        <div className="space-y-6">
          {community && <ClientCommunityContext view={community} />}

          <Card className="p-6 shadow-grounded sm:p-7">
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

      {/* shortcuts — square tiles, bottom row. The Grant Report and IntellEngine
          tiles appear ONLY when their card is absent: with the card present the tile
          is a second door to the same place, and two entry points to one destination
          on one screen is how a dashboard starts feeling arbitrary. */}
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
    </div>
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
  const cls = `flex flex-col gap-2 rounded-2xl p-5 shadow-grounded transition ${
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
