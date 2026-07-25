"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { Search } from "lucide-react";
import { DecisionBadge } from "@/components/grants/badges";
import { HeroBand } from "@/components/layout/hero-band";
import { ScoreRing, FactorMark, Tag } from "./primitives";
import { ConceptProposalReveal } from "./concept-proposal-reveal";
import { PursuitChooser } from "./pursuit-chooser";
import { factorDisplay, reportStats, type ReportItem } from "@/lib/report/shape";

type Filter =
  | "all"
  | "strong"
  | "soon"
  | "pursuing"
  | "to_decide"
  | "in_progress"
  | "intellengine"
  | "sme"
  | "in_house"
  | "archived";

// Staff view: honest, data-backed filters (fit / deadline / decision). The Figma
// mock's Federal/State/Foundation isn't derivable, so we substitute real fields.
const STAFF_FILTERS: { key: Filter; label: string }[] = [
  { key: "all", label: "All" },
  { key: "strong", label: "Strong fit" },
  { key: "soon", label: "Deadline soon" },
  { key: "pursuing", label: "Pursuing" },
];

// Client view: the report is a decision workflow (migration 0061). Default shows
// grants still awaiting a pursuit decision; the rest are grouped by how they're
// being pursued. "Passed" is the folded-in Grant Ledger -- the archive of grants
// the client looked at and declined (only shown when there are any).
const CLIENT_FILTERS: { key: Filter; label: string }[] = [
  { key: "to_decide", label: "To decide" },
  { key: "in_progress", label: "In progress" },
  { key: "intellengine", label: "IntellEngine" },
  { key: "sme", label: "With an SME" },
  { key: "in_house", label: "In-house" },
  { key: "archived", label: "Passed" },
];

function matchesFilter(item: ReportItem, f: Filter): boolean {
  switch (f) {
    case "strong":
      return item.fitScore === 3;
    case "soon":
      return item.deadlineSoon;
    case "pursuing":
      return item.decision === "approved";
    case "to_decide":
      // Awaiting a pursuit decision -- but a passed grant clears its path back to
      // null, so exclude passed here (it lives under "Passed" / the old Ledger).
      return item.decision !== "passed" && item.pursuitPath === null;
    case "in_progress":
      return item.pursuitPath !== null;
    case "intellengine":
      return item.pursuitPath === "intellengine";
    case "sme":
      return item.pursuitPath === "sme";
    case "in_house":
      return item.pursuitPath === "in_house";
    case "archived":
      return item.decision === "passed";
    default:
      return true; // "all"
  }
}

export function GrantReport({
  items,
  heading,
  subtitle,
  basePath,
  clientName,
  tier,
}: {
  items: ReportItem[];
  heading: string;
  subtitle?: string;
  // Where a row links to, e.g. "/portal/grants". Detail is `${basePath}/${id}`.
  basePath: string;
  // Client org name — threaded on the client portal for the concept-proposal reveal
  // / base-tier upsell mailto. Absent on staff surfaces (items carry no concept there).
  clientName?: string;
  // Set on the CLIENT report only — switches on the pursuit-decision workflow
  // (0061): pursuit filters, "to decide" default, and the per-row pursuit chooser.
  // Absent on staff surfaces, which keep the plain fit/deadline/decision filters.
  tier?: "premium" | "base";
}) {
  const isClient = !!tier;
  const hasPassed = useMemo(() => items.some((i) => i.decision === "passed"), [items]);
  // Hide the "Passed" chip until there's something to show under it.
  const FILTERS = isClient
    ? CLIENT_FILTERS.filter((f) => f.key !== "archived" || hasPassed)
    : STAFF_FILTERS;
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<Filter>(isClient ? "to_decide" : "all");
  const stats = useMemo(() => reportStats(items), [items]);
  const inProgressCount = useMemo(() => items.filter((i) => i.pursuitPath !== null).length, [items]);

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
      {/* header — map-backed navy hero band (matches the dashboard) */}
      <div className="animate-fade-up">
        <HeroBand
          title={heading}
          subtitle={subtitle}
          stats={[
            { value: String(stats.matched), label: "Matched grants" },
            {
              value: (
                <>
                  {stats.avgFit ?? "—"}
                  {stats.avgFit && <span className="text-base font-normal text-white/50">/3</span>}
                </>
              ),
              label: "Avg fit",
            },
            { value: String(stats.dueSoon), label: "Due in 30 days", accent: true },
          ]}
        />
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
              {f.key === "in_progress" && inProgressCount > 0 ? `${f.label} · ${inProgressCount}` : f.label}
            </button>
          );
        })}
      </div>

      {/* rows */}
      {visible.length === 0 ? (
        <div className="rounded-2xl border border-brand-navy/[0.05] bg-white py-16 text-center text-sm text-muted-foreground shadow-card">
          {items.length === 0
            ? "No matched opportunities yet. New matches appear here as your GRANTED team surfaces them."
            : "No grants match this view. Clear the search or filter to see the full roadmap."}
        </div>
      ) : (
        <div className="space-y-4">
          {visible.map((item, i) => (
            <Row key={item.id} item={item} href={`${basePath}/${item.id}`} index={i} clientName={clientName} tier={tier} />
          ))}
        </div>
      )}
    </div>
  );
}

function Row({
  item,
  href,
  index,
  clientName,
  tier,
}: {
  item: ReportItem;
  href: string;
  index: number;
  clientName?: string;
  tier?: "premium" | "base";
}) {
  return (
    // Stretched-link pattern: the whole card navigates via an absolute overlay
    // anchor, so the concept-proposal button can live above it (z-2) as a real,
    // separately-clickable control without nesting a <button> inside an <a>.
    <div
      style={{ animationDelay: `${Math.min(index, 8) * 45}ms` }}
      className="animate-fade-up relative rounded-2xl border border-brand-navy/[0.05] bg-white p-6 shadow-card transition duration-200 hover:-translate-y-0.5 hover:shadow-lift"
    >
      <Link href={href} aria-label={`View ${item.title}`} className="absolute inset-0 z-[1] rounded-2xl" />
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
          {item.smeReleased && (
            <span className="rounded-full bg-emerald-50 px-3 py-1 text-[11px] font-semibold text-emerald-700 ring-1 ring-emerald-200">
              Released to client
            </span>
          )}
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
          <div className="mt-1 flex flex-wrap items-center justify-end gap-2">
            {tier && (
              <div className="relative z-[2]">
                <PursuitChooser cardId={item.id} pursuitPath={item.pursuitPath} tier={tier} variant="row" />
              </div>
            )}
            {item.concept && (
              <div className="relative z-[2]">
                <ConceptProposalReveal concept={item.concept} clientName={clientName} variant="row" />
              </div>
            )}
            <span className="rounded-full bg-brand-navy px-5 py-1.5 text-xs font-semibold text-white">View</span>
          </div>
        </div>
      </div>
    </div>
  );
}
