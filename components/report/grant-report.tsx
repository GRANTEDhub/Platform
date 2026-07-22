"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { Search } from "lucide-react";
import { DecisionBadge } from "@/components/grants/badges";
import { ScoreRing, FactorMark, Tag } from "./primitives";
import { factorDisplay, reportStats, type ReportItem } from "@/lib/report/shape";

type Filter = "all" | "strong" | "soon" | "pursuing";

// Honest, data-backed filters. The Figma mock showed Federal/State/Foundation —
// the platform can't reliably derive funder level, so we substitute filters that
// map to real fields (fit score, deadline, decision) in the same pill row.
const FILTERS: { key: Filter; label: string }[] = [
  { key: "all", label: "All" },
  { key: "strong", label: "Strong fit" },
  { key: "soon", label: "Deadline soon" },
  { key: "pursuing", label: "Pursuing" },
];

function matchesFilter(item: ReportItem, f: Filter): boolean {
  if (f === "strong") return item.fitScore === 3;
  if (f === "soon") return item.deadlineSoon;
  if (f === "pursuing") return item.decision === "approved";
  return true;
}

export function GrantReport({
  items,
  heading,
  subtitle,
  basePath,
}: {
  items: ReportItem[];
  heading: string;
  subtitle?: string;
  // Where a row links to, e.g. "/portal/grants". Detail is `${basePath}/${id}`.
  basePath: string;
}) {
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<Filter>("all");
  const stats = useMemo(() => reportStats(items), [items]);

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return items.filter((i) => {
      if (!matchesFilter(i, filter)) return false;
      if (!q) return true;
      return i.title.toLowerCase().includes(q) || (i.funder ?? "").toLowerCase().includes(q);
    });
  }, [items, query, filter]);

  return (
    <div>
      {/* header card */}
      <div className="animate-fade-up rounded-3xl bg-white p-8 shadow-soft">
        <h1 className="font-serif text-[30px] font-semibold leading-tight tracking-tight text-brand-navy">{heading}</h1>
        {subtitle && <p className="mt-2 text-[14px] text-muted-foreground">{subtitle}</p>}

        <div className="mt-6 flex flex-wrap gap-x-12 gap-y-4 border-t border-brand-navy/[0.06] pt-5">
          <Stat value={String(stats.matched)} label="Matched grants" />
          <Stat value={stats.avgFit ?? "—"} suffix={stats.avgFit ? "/3" : undefined} label="Avg fit" />
          <Stat value={String(stats.dueSoon)} label="Due in 30 days" accent />
        </div>
      </div>

      {/* search + filters */}
      <div className="mb-5 mt-5 flex flex-wrap items-center gap-3">
        <div className="relative min-w-[240px] flex-1">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search grants…"
            className="w-full rounded-full border border-brand-navy/15 bg-white py-2.5 pl-10 pr-4 text-sm outline-none transition focus:border-brand-navy/35 focus:ring-2 focus:ring-brand-navy/10"
          />
        </div>
        {FILTERS.map((f) => {
          const active = filter === f.key;
          return (
            <button
              key={f.key}
              onClick={() => setFilter(f.key)}
              className={`rounded-full px-4 py-2 text-sm font-medium transition ${
                active
                  ? "bg-brand-navy text-white"
                  : "border border-brand-navy/15 text-muted-foreground hover:border-brand-navy/30 hover:text-brand-navy"
              }`}
            >
              {f.label}
            </button>
          );
        })}
      </div>

      {/* rows */}
      {visible.length === 0 ? (
        <div className="rounded-2xl border border-brand-navy/[0.05] bg-white py-16 text-center text-sm text-muted-foreground shadow-soft">
          {items.length === 0
            ? "No matched opportunities yet. New matches appear here as your GRANTED team surfaces them."
            : "No grants match this view. Clear the search or filter to see the full roadmap."}
        </div>
      ) : (
        <div className="space-y-4">
          {visible.map((item, i) => (
            <Row key={item.id} item={item} href={`${basePath}/${item.id}`} index={i} />
          ))}
        </div>
      )}
    </div>
  );
}

function Stat({ value, suffix, label, accent }: { value: string; suffix?: string; label: string; accent?: boolean }) {
  return (
    <div>
      <p className={`text-[24px] font-semibold leading-none ${accent ? "text-brand-orange" : "text-brand-navy"}`}>
        {value}
        {suffix && <span className="text-base font-normal text-muted-foreground">{suffix}</span>}
      </p>
      <p className="mt-1.5 text-[11px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">{label}</p>
    </div>
  );
}

function Row({ item, href, index }: { item: ReportItem; href: string; index: number }) {
  return (
    <Link
      href={href}
      style={{ animationDelay: `${Math.min(index, 8) * 45}ms` }}
      className="animate-fade-up block rounded-2xl border border-brand-navy/[0.05] bg-white p-6 shadow-soft transition duration-200 hover:-translate-y-0.5 hover:shadow-lift"
    >
      <div className="flex items-center gap-6">
        <ScoreRing fitScore={item.fitScore} band={item.band} />

        <div className="min-w-0 flex-1">
          <h3 className="font-serif text-[19px] font-semibold leading-snug text-brand-navy">{item.title}</h3>
          {item.funder && <p className="text-[13.5px] text-muted-foreground">{item.funder}</p>}

          {(item.role || item.focusAreas.length > 0) && (
            <div className="mt-2 flex flex-wrap gap-2">
              {item.role && <Tag>{item.role}</Tag>}
              {item.focusAreas.map((f, j) => (
                <Tag key={j}>{f}</Tag>
              ))}
            </div>
          )}

          <div className="mt-2.5 flex flex-wrap gap-x-4 gap-y-1 text-[12.5px]">
            {item.rowFactors.map((f) => {
              const d = factorDisplay(f.rating);
              return (
                <span key={f.key} className="inline-flex items-center gap-1">
                  <FactorMark mark={d.mark} className={d.className} />
                  <span className="text-muted-foreground">{f.label}</span>
                </span>
              );
            })}
          </div>
        </div>

        <div className="flex shrink-0 flex-col items-end gap-1.5 text-right">
          {item.decision !== "pending" && <DecisionBadge decision={item.decision} />}
          <p className="text-[15px] font-semibold text-brand-navy">
            {item.awardRange}
            {item.awardIsEstimate && <span className="ml-1 text-[11px] font-normal text-muted-foreground">est.</span>}
          </p>
          <p className="text-[12.5px] text-muted-foreground">
            {item.deadlineLabel}
            {item.deadlineSoon && item.deadlineDaysLeft !== null && (
              <span className="ml-1 font-medium text-brand-orange">· {item.deadlineDaysLeft}d left</span>
            )}
          </p>
          <span className="mt-1 rounded-full bg-brand-navy px-5 py-1.5 text-xs font-semibold text-white">View</span>
        </div>
      </div>
    </Link>
  );
}
