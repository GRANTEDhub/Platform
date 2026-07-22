import Link from "next/link";
import { differenceInCalendarDays, format, parseISO } from "date-fns";
import {
  Building2,
  CheckCircle2,
  DollarSign,
  CalendarClock,
  type LucideIcon,
} from "lucide-react";
import { requireAdmin } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { cn, formatCurrency } from "@/lib/utils";
import { NON_LEAD_OR_FILTER } from "@/lib/leads/stage";
import type { ClientOverview, CardDecision } from "@/types/database";

export const dynamic = "force-dynamic";

// The client hub: the single roster surface. One card per client, rolled up by
// their LIVE grant pipeline (approved = active opportunities, pending = in review)
// plus fit, next deadline, and a quiet money footer (owed + retainer hours). This
// consolidates what used to be three overlapping pages (dashboard / portfolio /
// clients list) into one. Pipeline counts are real (from review_cards); award
// dollars are deliberately NOT summed (grant funding is free-text — a "pipeline
// value" would be false precision). Read-only, staff-only; client detail/edit/add
// live underneath at /clients/[id], /clients/[id]/edit, /clients/new.
//
// Styling is page-local — the approved visual-refresh execution (clean sans,
// solid brand avatars, crisp cards) pending the platform-wide shared-component
// rollout.

function statusPill(status: string): string {
  switch (status) {
    case "active":
      return "bg-emerald-50 text-emerald-700";
    case "paused":
      return "bg-amber-50 text-amber-700";
    case "prospect":
      return "bg-brand-navy/[0.06] text-brand-navy";
    default:
      return "bg-muted text-muted-foreground";
  }
}

function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "—";
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

// Stable solid navy/orange fill per client (hashed on id, so the color never
// shifts when the sort order changes).
function monogramFill(seed: string): string {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) | 0;
  return Math.abs(h) % 2 === 0 ? "bg-brand-navy" : "bg-brand-orange";
}

function deadlineParts(date: string | null): { top: string; bottom: string; urgent: boolean } {
  if (!date) return { top: "—", bottom: "no deadline", urgent: false };
  const days = differenceInCalendarDays(parseISO(date), new Date());
  if (days < 0) return { top: format(parseISO(date), "MMM d"), bottom: "overdue", urgent: true };
  return {
    top: format(parseISO(date), "MMM d"),
    bottom: `${days} ${days === 1 ? "day" : "days"}`,
    urgent: days <= 14,
  };
}

type Rollup = { active: number; inReview: number; fitSum: number; fitCount: number };
const EMPTY_ROLLUP: Rollup = { active: 0, inReview: 0, fitSum: 0, fitCount: 0 };

export default async function ClientsPage() {
  await requireAdmin();
  const supabase = createClient();

  const { data: overviewData } = await supabase
    .from("client_overview")
    .select("*")
    .or(NON_LEAD_OR_FILTER)
    .order("name");
  const clients = (overviewData ?? []) as ClientOverview[];
  const ids = clients.map((c) => c.id);

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
    if ((c.decision === "approved" || c.decision === "pending") && typeof c.fit_score === "number") {
      r.fitSum += c.fit_score;
      r.fitCount += 1;
    }
    byClient.set(c.client_id, r);
  }

  const rows = clients
    .map((c) => ({ c, r: byClient.get(c.id) ?? EMPTY_ROLLUP }))
    .sort((a, b) => b.r.active - a.r.active || a.c.name.localeCompare(b.c.name));

  const activeCount = clients.filter((c) => c.status === "active").length;
  const totalActive = rows.reduce((s, { r }) => s + r.active, 0);
  const totalOwedCents = clients.reduce((s, c) => s + (c.owed_cents || 0), 0);
  const deadlineSoon = clients.filter(
    (c) => c.next_deadline && differenceInCalendarDays(parseISO(c.next_deadline), new Date()) <= 30,
  ).length;

  return (
    <div className="px-6 py-8 lg:px-10 lg:py-9">
      <header className="mb-8 flex items-start justify-between gap-4">
        <div>
          <h1 className="text-[30px] font-semibold tracking-tight text-brand-navy">Clients</h1>
          <p className="mt-1.5 text-[15px] text-muted-foreground">
            Your roster — grant pipeline and account status at a glance.
          </p>
        </div>
        <Link
          href="/clients/new"
          className="shrink-0 rounded-full bg-brand-navy px-5 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-brand-navyDeep"
        >
          + Add client
        </Link>
      </header>

      <div className="mb-8 grid grid-cols-2 gap-4 lg:grid-cols-4">
        <SummaryTile icon={Building2} tone="navy" value={String(activeCount)} label="active clients" hint={`${clients.length} total`} />
        <SummaryTile icon={CheckCircle2} tone="orange" value={String(totalActive)} label="active opportunities" />
        <SummaryTile icon={DollarSign} tone="orange" value={formatCurrency(totalOwedCents / 100)} label="outstanding" />
        <SummaryTile icon={CalendarClock} tone="navy" value={String(deadlineSoon)} label="deadlines ≤30d" />
      </div>

      {rows.length === 0 ? (
        <div className="rounded-2xl border border-brand-navy/[0.05] bg-white p-12 text-center text-muted-foreground shadow-soft">
          No clients yet. Add your first client to get started.
        </div>
      ) : (
        <div className="grid gap-5 sm:grid-cols-2 xl:grid-cols-3">
          {rows.map(({ c, r }) => {
            const dl = deadlineParts(c.next_deadline);
            const avgFit = r.fitCount > 0 ? (r.fitSum / r.fitCount).toFixed(1) : null;
            const subtitle =
              [c.org_type?.replace(/_/g, " "), locById.get(c.id)].filter(Boolean).join(" · ") || "—";
            const owedText = c.owed_cents > 0 ? `${formatCurrency(c.owed_cents / 100)} owed` : "Paid up";
            const hoursText =
              c.hours_remaining != null ? `${Number(c.hours_remaining).toFixed(1)}h left` : null;
            const money = [owedText, hoursText].filter(Boolean).join("  ·  ");
            return (
              <Link key={c.id} href={`/clients/${c.id}`} className="block">
                <div className="rounded-2xl border border-brand-navy/[0.05] bg-white p-6 shadow-soft transition hover:shadow-lift">
                  <div className="flex items-center gap-3.5">
                    <div
                      className={cn(
                        "flex h-12 w-12 shrink-0 items-center justify-center rounded-full text-[15px] font-semibold text-white",
                        monogramFill(c.id),
                      )}
                    >
                      {initials(c.name)}
                    </div>
                    <div className="min-w-0 flex-1">
                      <h3 className="truncate text-[16px] font-semibold leading-tight text-brand-navy">
                        {c.name}
                      </h3>
                      <p className="mt-0.5 truncate text-[13px] capitalize text-muted-foreground">
                        {subtitle}
                      </p>
                    </div>
                    <span
                      className={cn(
                        "shrink-0 rounded-full px-2.5 py-1 text-[11px] font-medium capitalize",
                        statusPill(c.status),
                      )}
                    >
                      {c.status}
                    </span>
                  </div>

                  <div className="mt-5 flex items-end justify-between border-t border-brand-navy/[0.06] pt-4">
                    <Metric value={String(r.active)} label="Active" accent />
                    <Metric value={String(r.inReview)} label="In review" />
                    <Metric value={avgFit ?? "—"} label="Avg fit" />
                    <div className="text-right">
                      <p
                        className={cn(
                          "text-[15px] font-semibold leading-none",
                          dl.urgent ? "text-brand-orange" : "text-brand-navy",
                        )}
                      >
                        {dl.top}
                      </p>
                      <p className="mt-1.5 text-[11px] text-muted-foreground">{dl.bottom}</p>
                    </div>
                  </div>

                  <p className="mt-3 text-[12px] text-muted-foreground">{money}</p>
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
  hint,
}: {
  icon: LucideIcon;
  tone: "navy" | "orange";
  value: string;
  label: string;
  hint?: string;
}) {
  return (
    <div className="rounded-2xl border border-brand-navy/[0.05] bg-white p-5 shadow-soft">
      <div className="flex items-center gap-3.5">
        <span
          className={cn(
            "grid h-11 w-11 shrink-0 place-items-center rounded-xl text-white",
            tone === "orange" ? "bg-brand-orange" : "bg-brand-navy",
          )}
        >
          <Icon className="h-[18px] w-[18px]" />
        </span>
        <div className="min-w-0">
          <p className="text-[26px] font-semibold leading-none text-brand-navy">{value}</p>
          <p className="mt-1.5 truncate text-[13px] text-muted-foreground">
            {label}
            {hint ? <span className="text-muted-foreground/70"> · {hint}</span> : null}
          </p>
        </div>
      </div>
    </div>
  );
}

function Metric({ value, label, accent }: { value: string; label: string; accent?: boolean }) {
  return (
    <div>
      <p
        className={cn(
          "text-[22px] font-semibold leading-none",
          accent ? "text-brand-orange" : "text-brand-navy",
        )}
      >
        {value}
      </p>
      <p className="mt-1.5 text-[11px] text-muted-foreground">{label}</p>
    </div>
  );
}
