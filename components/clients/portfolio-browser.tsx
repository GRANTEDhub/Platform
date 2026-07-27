"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { differenceInCalendarDays, format, parseISO } from "date-fns";
import { cn } from "@/lib/utils";

// The Portfolio grid + its two controls: a live name search (type-to-filter, like the
// Ledger) and a Clients / Prospects / All toggle. Rows are precomputed server-side
// (roster + grant-pipeline rollup) and passed in; all filtering is client-side over
// that in-memory list, so it's instant and needs no round-trip.
export type PortfolioRow = {
  id: string;
  name: string;
  subtitle: string;
  status: string;
  isProspect: boolean;
  active: number;
  inReview: number;
  avgFit: string | null;
  nextDeadline: string | null; // ISO date
  money: string | null; // owed / hours footer — clients only (null for prospects)
};

type Filter = "all" | "clients" | "prospects";

function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "—";
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

function monogramFill(seed: string): string {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) | 0;
  return Math.abs(h) % 2 === 0 ? "bg-brand-navy" : "bg-brand-orange";
}

function deadlineParts(date: string | null): { top: string; bottom: string; urgent: boolean } {
  if (!date) return { top: "—", bottom: "no deadline", urgent: false };
  const days = differenceInCalendarDays(parseISO(date), new Date());
  if (days < 0) return { top: format(parseISO(date), "MMM d"), bottom: "overdue", urgent: true };
  return { top: format(parseISO(date), "MMM d"), bottom: `${days} ${days === 1 ? "day" : "days"}`, urgent: days <= 14 };
}

function statusPill(status: string, isProspect: boolean): { label: string; cls: string } {
  if (isProspect) return { label: "prospect", cls: "bg-brand-orange/10 text-brand-orange" };
  switch (status) {
    case "active":
      return { label: status, cls: "bg-emerald-50 text-emerald-700" };
    case "paused":
      return { label: status, cls: "bg-amber-50 text-amber-700" };
    default:
      return { label: status, cls: "bg-muted text-muted-foreground" };
  }
}

export function PortfolioBrowser({ rows }: { rows: PortfolioRow[] }) {
  const [q, setQ] = useState("");
  const [filter, setFilter] = useState<Filter>("all");

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return rows.filter((r) => {
      if (filter === "clients" && r.isProspect) return false;
      if (filter === "prospects" && !r.isProspect) return false;
      if (needle && !r.name.toLowerCase().includes(needle)) return false;
      return true;
    });
  }, [rows, q, filter]);

  return (
    <>
      <div className="mb-6 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search by name…"
          className="h-10 w-full rounded-full border border-brand-navy/[0.12] bg-white px-4 text-sm outline-none focus:border-brand-navy/30 sm:max-w-xs"
        />
        <div className="flex gap-1 rounded-full bg-brand-navy/[0.06] p-1 text-sm">
          {(["all", "clients", "prospects"] as const).map((f) => (
            <button
              key={f}
              onClick={() => setFilter(f)}
              className={cn(
                "rounded-full px-4 py-1.5 font-medium capitalize transition-colors",
                filter === f ? "bg-white text-brand-navy shadow-soft" : "text-muted-foreground hover:text-brand-navy",
              )}
            >
              {f}
            </button>
          ))}
        </div>
      </div>

      {filtered.length === 0 ? (
        <div className="rounded-2xl border border-brand-navy/[0.05] bg-white p-12 text-center text-muted-foreground shadow-soft">
          {rows.length === 0 ? "No clients or prospects yet." : "No matches."}
        </div>
      ) : (
        <div className="grid gap-5 sm:grid-cols-2 xl:grid-cols-3">
          {filtered.map((r) => {
            const dl = deadlineParts(r.nextDeadline);
            const pill = statusPill(r.status, r.isProspect);
            return (
              <Link key={r.id} href={`/clients/${r.id}`} className="block">
                <div className="rounded-2xl border border-brand-navy/[0.05] bg-white p-6 shadow-soft transition hover:shadow-lift">
                  <div className="flex items-center gap-3.5">
                    <div className={cn("flex h-12 w-12 shrink-0 items-center justify-center rounded-full text-[15px] font-semibold text-white", monogramFill(r.id))}>
                      {initials(r.name)}
                    </div>
                    <div className="min-w-0 flex-1">
                      <h3 className="truncate text-[16px] font-semibold leading-tight text-brand-navy">{r.name}</h3>
                      <p className="mt-0.5 truncate text-[13px] capitalize text-muted-foreground">{r.subtitle}</p>
                    </div>
                    <span className={cn("shrink-0 rounded-full px-2.5 py-1 text-[11px] font-medium capitalize", pill.cls)}>
                      {pill.label}
                    </span>
                  </div>

                  <div className="mt-5 flex items-end justify-between border-t border-brand-navy/[0.06] pt-4">
                    <Metric value={String(r.active)} label="Active" accent />
                    <Metric value={String(r.inReview)} label="In review" />
                    <Metric value={r.avgFit ?? "—"} label="Avg fit" />
                    <div className="text-right">
                      <p className={cn("text-[15px] font-semibold leading-none", dl.urgent ? "text-brand-orange" : "text-brand-navy")}>{dl.top}</p>
                      <p className="mt-1.5 text-[11px] text-muted-foreground">{dl.bottom}</p>
                    </div>
                  </div>

                  {r.money && <p className="mt-3 text-[12px] text-muted-foreground">{r.money}</p>}
                </div>
              </Link>
            );
          })}
        </div>
      )}
    </>
  );
}

function Metric({ value, label, accent }: { value: string; label: string; accent?: boolean }) {
  return (
    <div>
      <p className={cn("text-[22px] font-semibold leading-none", accent ? "text-brand-orange" : "text-brand-navy")}>{value}</p>
      <p className="mt-1.5 text-[11px] text-muted-foreground">{label}</p>
    </div>
  );
}
