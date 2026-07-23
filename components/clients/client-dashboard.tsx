import Link from "next/link";
import { ArrowRight, Bell, CalendarPlus, Flag, LifeBuoy, MessageSquare, Target, type LucideIcon } from "lucide-react";
import { Card } from "@/components/ui/card";
import { ClientMatchChart } from "@/components/clients/client-match-chart";
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
}

export function ClientDashboard({
  name,
  subLine,
  isStaff,
  roadmapHref,
  stats,
  actionItems,
  activity,
  bookingUrl,
  editHref,
  refresh,
  matchNote,
}: {
  name: string;
  subLine: string | null;
  isStaff: boolean;
  roadmapHref: string;
  stats: DashStat[];
  actionItems: DashActionItem[];
  activity: { pending: number; approved: number; passed: number };
  bookingUrl: string | null;
  editHref?: string | null;
  refresh?: React.ReactNode; // staff-only refresh control
  matchNote?: React.ReactNode; // staff-only in-progress indicator
}) {
  const scheduleHref = bookingUrl || `mailto:${SUPPORT}?subject=Schedule%20a%20strategy%20call`;
  return (
    <div className="mx-auto max-w-7xl px-8 py-8">
      {/* header — client name kept up top */}
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div className="min-w-0">
          <h1 className="font-serif text-[32px] font-semibold leading-tight tracking-tight text-brand-navy">{name}</h1>
          {subLine && <p className="mt-1 text-[14px] text-muted-foreground">{subLine}</p>}
        </div>
        {isStaff && (editHref || refresh) && (
          <div className="flex items-center gap-3">
            {editHref && (
              <Link
                href={editHref}
                className="rounded-full border border-brand-navy/20 px-4 py-2 text-sm font-medium text-brand-navy transition hover:bg-brand-navy/5"
              >
                Edit profile
              </Link>
            )}
            {refresh}
          </div>
        )}
      </div>
      {isStaff && matchNote}

      {/* stat row */}
      <div className="mt-6 grid grid-cols-2 gap-4 lg:grid-cols-4">
        {stats.map((s) => (
          <StatTile key={s.label} {...s} />
        ))}
      </div>

      {/* main grid: content left, shortcuts right */}
      <div className="mt-6 grid gap-6 lg:grid-cols-3">
        <div className="space-y-6 lg:col-span-2">
          <Card className="p-6 sm:p-7">
            <h2 className="font-serif text-[20px] font-semibold text-brand-navy">Action items</h2>
            <ul className="mt-4 divide-y divide-brand-navy/[0.06]">
              {activity.pending > 0 && (
                <li>
                  <Link
                    href={roadmapHref}
                    className="flex items-center justify-between gap-4 rounded-xl bg-brand-orange/[0.07] px-4 py-3 transition hover:bg-brand-orange/[0.12]"
                  >
                    <span className="flex items-center gap-3">
                      <Bell className="h-5 w-5 shrink-0 text-brand-orange" />
                      <span className="text-sm font-semibold text-brand-navy">
                        Catch up on grant alerts · {activity.pending} new
                      </span>
                    </span>
                    <ArrowRight className="h-4 w-4 shrink-0 text-brand-orange" />
                  </Link>
                </li>
              )}
              {actionItems.map((it) => (
                <ActionRow key={it.id} item={it} />
              ))}
              {activity.pending === 0 && actionItems.length === 0 && (
                <li className="py-3 text-sm text-muted-foreground">Nothing needs your attention right now.</li>
              )}
            </ul>
          </Card>

          <Card className="p-6 sm:p-7">
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

        {/* shortcuts (moved into the space the roadmap card vacated) */}
        <div className="space-y-4">
          <QuickAction featured href={roadmapHref} icon={Target} title="Grant Report" sub="Review your matched opportunities" />
          <QuickAction external href={scheduleHref} icon={CalendarPlus} title="Schedule with an advisor" sub="Book a grant strategy call" />
          <QuickAction external href={`mailto:${SUPPORT}?subject=Question%20for%20my%20GRANTED%20team`} icon={MessageSquare} title="Message your team" sub="In-app messaging — coming soon" />
          <QuickAction external href={`mailto:${SUPPORT}?subject=Help`} icon={LifeBuoy} title="Help" sub="FAQ & support" />
        </div>
      </div>
    </div>
  );
}

function StatTile({ label, value, sub, icon: Icon, accent }: DashStat) {
  return (
    <Card className="flex items-center gap-4 p-5">
      <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-brand-navy/[0.06]">
        <Icon className={`h-5 w-5 ${accent ? "text-brand-orange" : "text-brand-navy"}`} />
      </span>
      <div className="min-w-0">
        <p className={`text-[26px] font-semibold leading-none ${accent ? "text-brand-orange" : "text-brand-navy"}`}>{value}</p>
        <p className="mt-1 text-[11px] font-semibold uppercase tracking-[0.1em] text-muted-foreground">{label}</p>
        {sub && <p className="mt-0.5 text-[12px] text-muted-foreground">{sub}</p>}
      </div>
    </Card>
  );
}

function ActionRow({ item }: { item: DashActionItem }) {
  const body = (
    <div className="flex items-center justify-between gap-4 py-3">
      <div className="min-w-0">
        <p className="truncate text-sm font-medium text-brand-navy">{item.title}</p>
        {item.tag && (
          <span className="mt-1 inline-block rounded-full bg-brand-navy/[0.06] px-2.5 py-0.5 text-[11px] font-medium text-brand-navy">
            {item.tag}
          </span>
        )}
      </div>
      <div className="flex shrink-0 flex-col items-end gap-0.5 text-right">
        {item.date && <span className="text-xs text-muted-foreground">{item.date}</span>}
        {item.priority && (
          <span className={`inline-flex items-center gap-1 text-xs font-medium ${item.priority === "high" ? "text-brand-orange" : "text-muted-foreground"}`}>
            <Flag className="h-3 w-3" />
            {item.priority === "high" ? "High" : "Medium"}
          </span>
        )}
      </div>
    </div>
  );
  return <li>{item.href ? <Link href={item.href} className="block hover:opacity-80">{body}</Link> : body}</li>;
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
  const cls = `flex items-center gap-3 rounded-2xl p-4 shadow-soft transition ${
    featured ? "bg-brand-navy text-white" : "border border-brand-navy/[0.08] bg-white text-brand-navy hover:border-brand-navy/20"
  }`;
  const inner = (
    <>
      <span className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-xl ${featured ? "bg-white/10" : "bg-brand-navy/[0.06]"}`}>
        <Icon className={`h-5 w-5 ${featured ? "text-brand-orange" : "text-brand-navy"}`} />
      </span>
      <span className="min-w-0">
        <span className="block text-[15px] font-semibold">{title}</span>
        <span className={`block text-[12px] ${featured ? "text-white/70" : "text-muted-foreground"}`}>{sub}</span>
      </span>
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
