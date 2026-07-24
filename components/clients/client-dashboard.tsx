import Link from "next/link";
import { CalendarPlus, Flag, History, LifeBuoy, MessageSquare, Sparkles, Target, type LucideIcon } from "lucide-react";
import { Card } from "@/components/ui/card";
import { ClientMatchChart } from "@/components/clients/client-match-chart";
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
}

export function ClientDashboard({
  name,
  subLine,
  isStaff,
  roadmapHref,
  ledgerHref,
  intellEngineHref,
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
  // Client-only: a read-only history of every grant ever surfaced + its
  // outcome. Staff already have their own full-history view elsewhere, so this
  // renders a 5th shortcut tile only when provided (client portal passes it;
  // the staff dashboard doesn't).
  ledgerHref?: string;
  // Client-only: entry point into the self-serve AI proposal-drafting flow
  // (IntellEngine). Same tile-only pattern as ledgerHref -- no persistent nav
  // yet, that's a separate, later redesign.
  intellEngineHref?: string;
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
        stats={stats.map((s) => ({ value: s.value, label: s.label, sub: s.sub, accent: s.accent }))}
      />
      {isStaff && matchNote}

      {/* main grid: action items (wide) + grant activity */}
      <div className="mt-8 grid gap-6 lg:grid-cols-3">
        <Card className="p-6 shadow-grounded sm:p-7 lg:col-span-2">
          <h2 className="font-serif text-[20px] font-semibold text-brand-navy">Action items</h2>
          {actionItems.length === 0 ? (
            <p className="mt-4 text-sm text-muted-foreground">Nothing needs your attention right now.</p>
          ) : (
            <ul className="mt-4 divide-y divide-brand-navy/[0.06]">
              {actionItems.map((it) => (
                <ActionRow key={it.id} item={it} />
              ))}
            </ul>
          )}
        </Card>

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

      {/* shortcuts — square tiles, bottom row */}
      <div className="mt-6 grid grid-cols-2 gap-4 lg:grid-cols-4">
        <QuickAction featured href={roadmapHref} icon={Target} title="Grant Report" sub="Review your matched opportunities" />
        {ledgerHref && (
          <QuickAction href={ledgerHref} icon={History} title="Grant Ledger" sub="Every grant we've surfaced, and what came of it" />
        )}
        {intellEngineHref && (
          <QuickAction href={intellEngineHref} icon={Sparkles} title="IntellEngine" sub="Draft a proposal with AI assistance" />
        )}
        <QuickAction external href={scheduleHref} icon={CalendarPlus} title="Schedule with an advisor" sub="Book a grant strategy call" />
        <QuickAction external href={`mailto:${SUPPORT}?subject=Question%20for%20my%20GRANTED%20team`} icon={MessageSquare} title="Message your team" sub="In-app messaging — coming soon" />
        <QuickAction external href={`mailto:${SUPPORT}?subject=Help`} icon={LifeBuoy} title="Help" sub="FAQ & support" />
      </div>
    </div>
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
