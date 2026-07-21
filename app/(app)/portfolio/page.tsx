import Link from "next/link";
import { differenceInCalendarDays, format, parseISO } from "date-fns";
import {
  Building2,
  CheckCircle2,
  ClipboardList,
  CalendarClock,
  Calendar,
  type LucideIcon,
} from "lucide-react";
import { requireAdmin } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { cn } from "@/lib/utils";
import { NON_LEAD_OR_FILTER } from "@/lib/leads/stage";
import type { ClientOverview, CardDecision } from "@/types/database";

export const dynamic = "force-dynamic";

// The portfolio cockpit: every active client on one screen, as cards, rolled up
// by their LIVE grant pipeline (approved = active opportunities, pending = in
// review) plus average fit and next deadline. A card-based counterpart to the
// dense billing-focused /dashboard table. Everything here is a real count from
// review_cards -- no dollar figures (funding is free-text on grants, so a summed
// "pipeline value" would be false precision) and no health signal we don't track.
// Read-only, staff-only; the client-facing view is a later pass.
//
// Styling is deliberately PAGE-LOCAL (not the shared Card/Stat/Badge primitives):
// this page is the prototype for the platform-wide visual refresh, so its look is
// proven here in isolation before the shared design system is touched.

function statusPill(status: string): string {
  switch (status) {
    case "active":
      return "bg-emerald-100 text-emerald-800";
    case "paused":
      return "bg-amber-100 text-amber-800";
    case "prospect":
      return "bg-brand-navy/10 text-brand-navy";
    default:
      return "bg-muted text-muted-foreground";
  }
}

// Monogram initials for the client avatar: first+last initial, or the first two
// letters of a single-word name.
function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "—";
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

// Stable navy/orange tint per client (hashed on id, so the color never shifts
// when the sort order changes) -- gives the avatar grid some life, echoing the
// mock's colored monograms, in-palette.
function monogramTint(seed: string): string {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) | 0;
  return Math.abs(h) % 2 === 0
    ? "bg-brand-navy/10 text-brand-navy"
    : "bg-brand-orange/10 text-brand-orange";
}

// Deadline with an urgency tell, mirroring the dashboard's DeadlineCell (≤14d is
// hot). next_deadline is already the soonest approved-match deadline (computed in
// the client_overview view), so this is a pure format.
function deadlineDisplay(date: string | null): { text: string; urgent: boolean } {
  if (!date) return { text: "—", urgent: false };
  const days = differenceInCalendarDays(parseISO(date), new Date());
  return { text: `${format(parseISO(date), "MMM d")} · ${days}d`, urgent: days <= 14 };
}

type Rollup = { active: number; inReview: number; fitSum: number; fitCount: number };
const EMPTY_ROLLUP: Rollup = { active: 0, inReview: 0, fitSum: 0, fitCount: 0 };

export default async function PortfolioPage() {
  await requireAdmin();
  const supabase = createClient();

  // Roster from client_overview (excludes leads via the shared predicate) -- gives
  // name/org_type/status/next_deadline without a second clients query.
  const { data: overviewData } = await supabase
    .from("client_overview")
    .select("*")
    .or(NON_LEAD_OR_FILTER)
    .order("name");
  const clients = (overviewData ?? []) as ClientOverview[];
  const ids = clients.map((c) => c.id);

  // Per-client match rollups + location, both in single fetches over the roster's
  // ids, aggregated in code (same shape as the client-first gate). CLIENT cards
  // only -- prospect cards (Track 2) never count. location lives on clients (not
  // the overview view), so it's a light second read.
  type CardRow = {
    client_id: string | null;
    card_type: string | null;
    decision: CardDecision;
    fit_score: number | null;
  };
  let cards: CardRow[] = [];
  const locById = new Map<string, string>();
  if (ids.length > 0) {
    const [{ data: cardData }, { data: locData }] = await Promise.all([
      supabase
        .from("review_cards")
        .select("client_id, card_type, decision, fit_score")
        .in("client_id", ids)
        .neq("card_type", "prospect"),
      supabase.from("clients").select("id, location_city, location_state").in("id", ids),
    ]);
    cards = (cardData ?? []) as CardRow[];
    for (const l of (locData ?? []) as {
      id: string;
      location_city: string | null;
      location_state: string | null;
    }[]) {
      const cityState = [l.location_city, l.location_state].filter(Boolean).join(", ");
      if (cityState) locById.set(l.id, cityState);
    }
  }

  const byClient = new Map<string, Rollup>();
  for (const c of cards) {
    if (!c.client_id) continue;
    const r = byClient.get(c.client_id) ?? { ...EMPTY_ROLLUP };
    if (c.decision === "approved") r.active += 1;
    else if (c.decision === "pending") r.inReview += 1;
    // Avg fit reflects the LIVE pipeline (approved + pending); passed matches were
    // rejected and shouldn't drag the average of what's actually in play.
    if ((c.decision === "approved" || c.decision === "pending") && typeof c.fit_score === "number") {
      r.fitSum += c.fit_score;
      r.fitCount += 1;
    }
    byClient.set(c.client_id, r);
  }

  // Busiest first (most active opportunities), then alphabetical.
  const rows = clients
    .map((c) => ({ c, r: byClient.get(c.id) ?? EMPTY_ROLLUP }))
    .sort((a, b) => b.r.active - a.r.active || a.c.name.localeCompare(b.c.name));

  const totalActive = rows.reduce((s, { r }) => s + r.active, 0);
  const totalInReview = rows.reduce((s, { r }) => s + r.inReview, 0);
  const deadlineSoon = clients.filter(
    (c) => c.next_deadline && differenceInCalendarDays(parseISO(c.next_deadline), new Date()) <= 30,
  ).length;

  return (
    <div className="px-6 py-8 lg:px-10 lg:py-9">
      <header className="mb-9">
        <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-brand-orange">
          Operations hub
        </p>
        <h1 className="mt-2 font-serif text-[32px] font-semibold leading-tight tracking-tight text-brand-navy">
          Portfolio
        </h1>
        <p className="mt-2 text-[15px] text-muted-foreground">
          Every client&apos;s live grant pipeline at a glance.
        </p>
      </header>

      <div className="mb-9 grid grid-cols-2 gap-4 lg:grid-cols-4 lg:gap-5">
        <SummaryTile icon={Building2} tone="navy" value={String(clients.length)} label="clients" />
        <SummaryTile icon={CheckCircle2} tone="orange" value={String(totalActive)} label="active opportunities" />
        <SummaryTile icon={ClipboardList} tone="navy" value={String(totalInReview)} label="in review" />
        <SummaryTile icon={CalendarClock} tone="orange" value={String(deadlineSoon)} label="deadlines ≤30d" />
      </div>

      {rows.length === 0 ? (
        <div className="rounded-4xl bg-white p-12 text-center text-muted-foreground shadow-soft">
          No clients yet. Add your first client to get started.
        </div>
      ) : (
        <div className="grid gap-5 sm:grid-cols-2 xl:grid-cols-3 xl:gap-6">
          {rows.map(({ c, r }) => {
            const dl = deadlineDisplay(c.next_deadline);
            const avgFit = r.fitCount > 0 ? (r.fitSum / r.fitCount).toFixed(1) : null;
            const subtitle =
              [c.org_type?.replace(/_/g, " "), locById.get(c.id)].filter(Boolean).join(" · ") || "—";
            return (
              <Link key={c.id} href={`/clients/${c.id}`} className="group block">
                <div className="rounded-4xl bg-white p-7 shadow-soft transition-all group-hover:-translate-y-0.5 group-hover:shadow-lift">
                  <div className="flex items-start gap-4">
                    <span
                      className={cn(
                        "grid h-14 w-14 shrink-0 place-items-center rounded-2xl font-serif text-lg font-semibold",
                        monogramTint(c.id),
                      )}
                    >
                      {initials(c.name)}
                    </span>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-start justify-between gap-3">
                        <h3 className="truncate font-serif text-[19px] font-semibold leading-tight text-brand-navy">
                          {c.name}
                        </h3>
                        <span
                          className={cn(
                            "shrink-0 rounded-full px-2.5 py-1 text-[11px] font-medium capitalize",
                            statusPill(c.status),
                          )}
                        >
                          {c.status}
                        </span>
                      </div>
                      <p className="mt-1 truncate text-[13.5px] capitalize text-muted-foreground">
                        {subtitle}
                      </p>
                    </div>
                  </div>

                  <div className="mt-6 grid grid-cols-3 gap-2 rounded-3xl bg-brand-cream p-5">
                    <Metric label="Active" value={String(r.active)} accent />
                    <Metric label="In review" value={String(r.inReview)} />
                    <Metric label="Avg fit" value={avgFit ?? "—"} suffix={avgFit ? "/3" : undefined} />
                  </div>

                  <div className="mt-4 flex items-center gap-2 px-1 text-[13.5px]">
                    <Calendar className="h-4 w-4 shrink-0 text-muted-foreground" />
                    <span className="text-muted-foreground">Next deadline</span>
                    <span
                      className={cn(
                        "ml-auto font-medium tabular-nums",
                        dl.urgent ? "text-brand-orange" : "text-brand-navy",
                      )}
                    >
                      {dl.text}
                    </span>
                  </div>
                </div>
              </Link>
            );
          })}
        </div>
      )}
    </div>
  );
}

function SummaryTile({
  icon: Icon,
  tone,
  value,
  label,
}: {
  icon: LucideIcon;
  tone: "navy" | "orange";
  value: string;
  label: string;
}) {
  return (
    <div className="rounded-4xl bg-white p-6 shadow-soft">
      <div className="flex items-center gap-4">
        <span
          className={cn(
            "grid h-12 w-12 shrink-0 place-items-center rounded-2xl",
            tone === "orange" ? "bg-brand-orange/10 text-brand-orange" : "bg-brand-navy/10 text-brand-navy",
          )}
        >
          <Icon className="h-5 w-5" />
        </span>
        <div className="min-w-0">
          <p className="font-serif text-[30px] font-semibold leading-none text-brand-navy">{value}</p>
          <p className="mt-1.5 truncate text-[13px] text-muted-foreground">{label}</p>
        </div>
      </div>
    </div>
  );
}

function Metric({
  label,
  value,
  suffix,
  accent,
}: {
  label: string;
  value: string;
  suffix?: string;
  accent?: boolean;
}) {
  return (
    <div className="text-center">
      <p
        className={cn(
          "font-serif text-[26px] font-semibold leading-none",
          accent ? "text-brand-orange" : "text-brand-navy",
        )}
      >
        {value}
        {suffix && <span className="text-base text-muted-foreground">{suffix}</span>}
      </p>
      <p className="mt-2 text-[10px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">
        {label}
      </p>
    </div>
  );
}
