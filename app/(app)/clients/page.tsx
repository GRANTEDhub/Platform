import Link from "next/link";
import { differenceInCalendarDays, parseISO } from "date-fns";
import { Building2, CheckCircle2, DollarSign, CalendarClock, type LucideIcon } from "lucide-react";
import { requireUser } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { cn, formatCurrency } from "@/lib/utils";
import { isUnconvertedLead } from "@/lib/leads/stage";
import { PortfolioBrowser, type PortfolioRow } from "@/components/clients/portfolio-browser";
import type { ClientOverview, CardDecision } from "@/types/database";

export const dynamic = "force-dynamic";

// The roster surface: one card per client AND prospect, rolled up by their live grant
// pipeline (approved = active, pending = in review) plus fit, next deadline, and (for
// clients) a money footer. Prospects (un-converted leads) now populate here too, with
// a Clients / Prospects / All toggle + a live name search (PortfolioBrowser). Dead
// leads (archived / rejected) are excluded. Pipeline counts are real (review_cards);
// award dollars are deliberately NOT summed (grant funding is free-text). Read-only,
// staff-only; client/prospect detail lives under /clients/[id].

type Rollup = { active: number; inReview: number; fitSum: number; fitCount: number };
const EMPTY_ROLLUP: Rollup = { active: 0, inReview: 0, fitSum: 0, fitCount: 0 };

export default async function ClientsPage() {
  // Contractors see the roster (grant work), but NOT GRANTED's billing: the money
  // footer, the "outstanding" tile, and the admin-only "+ Add client" are gated.
  const profile = await requireUser();
  const isAdmin = profile.role === "admin";
  const supabase = createClient();

  const { data: overviewData } = await supabase.from("client_overview").select("*").order("name");
  // Include clients + active prospects (un-converted leads); drop dead leads.
  const clients = ((overviewData ?? []) as ClientOverview[]).filter(
    (c) => c.pipeline_stage !== "archived" && c.pipeline_stage !== "rejected",
  );
  const ids = clients.map((c) => c.id);

  type CardRow = { client_id: string | null; decision: CardDecision; fit_score: number | null };
  let cards: CardRow[] = [];
  const locById = new Map<string, string>();
  if (ids.length > 0) {
    const [{ data: cardData }, { data: locData }] = await Promise.all([
      supabase.from("review_cards").select("client_id, decision, fit_score").in("client_id", ids).neq("card_type", "prospect"),
      supabase.from("clients").select("id, location_city, location_state").in("id", ids),
    ]);
    cards = (cardData ?? []) as CardRow[];
    for (const l of (locData ?? []) as { id: string; location_city: string | null; location_state: string | null }[]) {
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

  const rows: PortfolioRow[] = clients
    .map((c) => {
      const r = byClient.get(c.id) ?? EMPTY_ROLLUP;
      const isProspect = isUnconvertedLead(c.pipeline_stage);
      const subtitle = [c.org_type?.replace(/_/g, " "), locById.get(c.id)].filter(Boolean).join(" · ") || "—";
      const owedText = c.owed_cents > 0 ? `${formatCurrency(c.owed_cents / 100)} owed` : "Paid up";
      const hoursText = c.hours_remaining != null ? `${Number(c.hours_remaining).toFixed(1)}h left` : null;
      return {
        id: c.id,
        name: c.name,
        subtitle,
        status: c.status,
        isProspect,
        active: r.active,
        inReview: r.inReview,
        avgFit: r.fitCount > 0 ? (r.fitSum / r.fitCount).toFixed(1) : null,
        nextDeadline: c.next_deadline,
        // Money footer is a client concept; prospects don't bill, and it's
        // GRANTED billing so contractors never see it.
        money: isProspect || !isAdmin ? null : [owedText, hoursText].filter(Boolean).join("  ·  "),
      };
    })
    // Clients first, then prospects; within each, most active then alphabetical.
    .sort(
      (a, b) => Number(a.isProspect) - Number(b.isProspect) || b.active - a.active || a.name.localeCompare(b.name),
    );

  const activeCount = clients.filter((c) => c.status === "active").length;
  const prospectCount = rows.filter((r) => r.isProspect).length;
  const totalActive = rows.reduce((s, r) => s + r.active, 0);
  const totalOwedCents = clients.reduce((s, c) => s + (c.owed_cents || 0), 0);
  const deadlineSoon = clients.filter(
    (c) => c.next_deadline && differenceInCalendarDays(parseISO(c.next_deadline), new Date()) <= 30,
  ).length;

  return (
    <div className="px-6 py-8 lg:px-10 lg:py-9">
      <header className="mb-8 flex items-start justify-between gap-4">
        <div>
          <h1 className="text-[30px] font-semibold tracking-tight text-brand-navy">Portfolio</h1>
          <p className="mt-1.5 text-[15px] text-muted-foreground">
            Your roster — clients and prospects, grant pipeline and account status at a glance.
          </p>
        </div>
        {isAdmin && (
          <Link
            href="/clients/new"
            className="shrink-0 rounded-full bg-brand-navy px-5 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-brand-navyDeep"
          >
            + Add client
          </Link>
        )}
      </header>

      <div className="mb-8 grid grid-cols-2 gap-4 lg:grid-cols-4">
        <SummaryTile icon={Building2} tone="navy" value={String(activeCount)} label="active clients" hint={`${prospectCount} prospect${prospectCount === 1 ? "" : "s"}`} />
        <SummaryTile icon={CheckCircle2} tone="orange" value={String(totalActive)} label="active opportunities" />
        {isAdmin && (
          <SummaryTile icon={DollarSign} tone="orange" value={formatCurrency(totalOwedCents / 100)} label="outstanding" />
        )}
        <SummaryTile icon={CalendarClock} tone="navy" value={String(deadlineSoon)} label="deadlines ≤30d" />
      </div>

      <PortfolioBrowser rows={rows} />
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
        <span className={cn("grid h-11 w-11 shrink-0 place-items-center rounded-xl text-white", tone === "orange" ? "bg-brand-orange" : "bg-brand-navy")}>
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
