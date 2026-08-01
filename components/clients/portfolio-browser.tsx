"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { format, parseISO } from "date-fns";
import { ArrowRight, ChevronRight, Clock, CornerUpLeft, Layers, MessageSquare, Plus, Search } from "lucide-react";
import { INK, STAGE } from "@/lib/brand";
import { ALERTS_THRESHOLD, type ActionReason } from "@/lib/clients/portfolio";
import type { PipelineStageKey } from "@/lib/clients/pipeline";
import { cn } from "@/lib/utils";

// The Portfolio roster, built to the approved design (design/portfolio/).
//
// TWO GRIDS, and the split is the page's whole argument: large cards for clients asking
// for something today, a quieter grid for everyone else. The rule that decides which is
// which lives in lib/clients/portfolio.ts.
//
// The quiet grid's bars use the STAGE scale's `muted` variants rather than the live
// colours at lower opacity. Opacity would let a big taupe segment on a settled client
// out-shout a small orange one on a client that needs work; a desaturated scale recedes
// as a whole while still reading as the same funnel.
//
// SNAPPED TO TOKENS, not reproduced literally: the mockup carries a few values within a
// hair of existing ones — 13px/11px card radii (→ RADIUS.card), a half-strength card
// shadow on the compact tiles (→ ELEVATION.card; a third elevation step is exactly what
// the two-step scale exists to prevent), #C9CDD4 and #B7BCC4 (→ INK.faint, which is the
// disabled-chevron token), and #6B7480 for absent values (→ INK.subtle). Minting
// near-duplicates of tokens is the drift the single-source rule is there to stop.

export type PortfolioRow = {
  id: string;
  name: string;
  subtitle: string;
  isProspect: boolean;
  alerts: number;
  deadlineDays: number | null;
  deadlineDate: string | null;
  questions: number;
  reason: ActionReason | null;
  counts: Record<PipelineStageKey, number>;
  totalGrants: number;
  inPursuit: number;
  emptyPipeline: boolean;
};

type Filter = "all" | "action" | "quiet";

const BAR_ORDER: PipelineStageKey[] = ["triage", "client", "approved", "pursuit", "passed"];

function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "—";
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

export function PortfolioBrowser({ rows, isAdmin }: { rows: PortfolioRow[]; isAdmin: boolean }) {
  const [q, setQ] = useState("");
  const [filter, setFilter] = useState<Filter>("all");

  const { action, quiet, matched } = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const matched = rows.filter((r) => !needle || r.name.toLowerCase().includes(needle));
    // Alphabetical within each group, as the design's own headers state. Not
    // most-urgent-first: the grid is scanned by name when you already know who you are
    // looking for, and the requires-action split has already done the prioritising.
    const byName = (a: PortfolioRow, b: PortfolioRow) => a.name.localeCompare(b.name);
    return {
      matched,
      action: matched.filter((r) => r.reason !== null).sort(byName),
      quiet: matched.filter((r) => r.reason === null).sort(byName),
    };
  }, [rows, q]);

  const clientCount = rows.filter((r) => !r.isProspect).length;
  const prospectCount = rows.filter((r) => r.isProspect).length;
  const actionTotal = rows.filter((r) => r.reason !== null).length;
  const emptyCount = quiet.filter((r) => r.emptyPipeline).length;

  const showAction = filter !== "quiet";
  const showQuiet = filter !== "action";

  return (
    <div className="flex min-h-full flex-col">
      {/* Context bar — chrome continuous with the command band above it, so it is
          full-bleed at the same 34px gutter rather than inside a content column. */}
      <div className="flex min-h-[60px] flex-wrap items-center justify-between gap-x-5 gap-y-3 border-b border-hairline-strong bg-white px-[34px] py-3">
        <div className="flex items-baseline gap-3">
          <h1 className="font-serif text-[19px] font-bold tracking-[-0.01em] text-brand-navy">Portfolio</h1>
          <p className="text-[12.5px] text-ink-subtle">
            {clientCount} {clientCount === 1 ? "client" : "clients"}
            {prospectCount > 0 && ` · ${prospectCount} ${prospectCount === 1 ? "prospect" : "prospects"}`}
            {actionTotal > 0 && (
              <>
                {" · "}
                <strong className="font-semibold text-brand-orange">{actionTotal} require action</strong>
              </>
            )}
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <div className="flex h-[34px] w-[190px] items-center gap-[7px] rounded-[10px] border border-edge bg-surface-sunken px-[11px]">
            <Search className="h-3.5 w-3.5 shrink-0 text-ink-faint" aria-hidden="true" />
            <input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Search by name…"
              aria-label="Search the roster by name"
              className="min-w-0 flex-1 bg-transparent text-[12.5px] text-brand-navy outline-none placeholder:text-ink-faint"
            />
          </div>

          <div className="flex items-center gap-[2px] rounded-pill bg-brand-navy/[0.055] p-[3px]">
            <Tab active={filter === "all"} onClick={() => setFilter("all")}>
              All {rows.length}
            </Tab>
            <Tab active={filter === "action"} onClick={() => setFilter("action")}>
              Requires action
              {actionTotal > 0 && (
                <span className="rounded-full bg-brand-orange px-1.5 py-px text-[10px] font-bold tabular-nums text-white">
                  {actionTotal}
                </span>
              )}
            </Tab>
            <Tab active={filter === "quiet"} onClick={() => setFilter("quiet")}>
              No action
            </Tab>
          </div>

          {isAdmin && (
            <Link
              href="/clients/new"
              className="inline-flex h-[34px] shrink-0 items-center gap-[7px] rounded-[10px] bg-brand-navy px-[14px] text-[13px] font-semibold text-white transition-colors duration-[120ms] hover:bg-brand-navyHover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-orange/60 focus-visible:ring-offset-2"
            >
              <Plus className="h-3.5 w-3.5" aria-hidden="true" />
              Add client
            </Link>
          )}
        </div>
      </div>

      <div className="flex flex-1 flex-col px-[34px] pb-[18px] pt-4">
        {matched.length === 0 ? (
          <p className="rounded-2xl bg-white px-6 py-12 text-center text-sm text-ink-subtle shadow-card">
            {rows.length === 0 ? "No clients or prospects yet." : `No matches for “${q.trim()}”.`}
          </p>
        ) : (
          <>
            {showAction && (
              <>
                <div className="flex flex-wrap items-center gap-2.5 pb-2.5">
                  <h2 className="font-serif text-[14.5px] font-bold text-brand-navy">Requires action</h2>
                  <span className="rounded-full bg-brand-orange px-2 py-0.5 text-[10.5px] font-bold leading-[1.4] tabular-nums text-white">
                    {action.length}
                  </span>
                  <span className="text-[11.5px] text-ink-subtle">Alphabetical</span>
                  {/* The legend states the rule the split is made on, so the page
                      explains itself rather than requiring you to infer the thresholds
                      from which cards happen to be up here. */}
                  <div className="ml-auto flex flex-wrap items-center gap-3.5 text-[11.5px] text-ink-subtle">
                    <Key color={STAGE.triage.color}>Alerts ≥ {ALERTS_THRESHOLD}</Key>
                    <Key color={STAGE.client.color}>Deadline ≤ 30d</Key>
                    <Key color={STAGE.approved.color}>Question waiting</Key>
                  </div>
                </div>

                {action.length === 0 ? (
                  <div className="mb-2 rounded-2xl border border-dashed border-brand-navy/[0.16] bg-white/40 px-6 py-8 text-center">
                    <p className="text-[12.5px] font-semibold text-ink-muted">Nothing needs you right now</p>
                    <p className="mx-auto mt-1 max-w-[240px] text-[11.5px] leading-[1.5] text-ink-subtle">
                      Every client is inside their alert and deadline thresholds.
                    </p>
                  </div>
                ) : (
                  <div className="grid gap-3.5 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 xl:auto-rows-[222px]">
                    {action.map((r) => (
                      <ActionCard key={r.id} row={r} />
                    ))}
                    {/* Closes the grid deliberately: without it the last row ends on a
                        ragged edge that reads as "the list was cut off". */}
                    <div className="hidden flex-col items-center justify-center gap-[7px] rounded-2xl border border-dashed border-brand-navy/[0.16] bg-white/40 px-4 xl:flex">
                      <p className="text-[12.5px] font-semibold text-ink-muted">
                        {action.length === 1 ? "That's the only one" : `That's all ${action.length}`}
                      </p>
                      <p className="max-w-[190px] text-center text-[11.5px] leading-[1.5] text-ink-subtle">
                        Everything else is below and can wait until the sweep
                      </p>
                    </div>
                  </div>
                )}
              </>
            )}

            {showQuiet && (
              <>
                <div className="flex flex-wrap items-center gap-2.5 pb-2.5 pt-4">
                  <h2 className="text-[10px] font-bold uppercase tracking-[0.13em] text-ink-subtle">No action needed</h2>
                  <span className="rounded-full bg-brand-navy/[0.08] px-2 py-0.5 text-[10.5px] font-semibold leading-[1.4] tabular-nums text-ink-muted">
                    {quiet.length}
                  </span>
                  <span className="ml-auto text-[11.5px] text-ink-subtle">
                    Alphabetical
                    {emptyCount > 0 && (
                      <>
                        {" · "}
                        {/* Empty is NOT the same as quiet: quiet means the work is done,
                            empty means nothing was ever found, which is usually a
                            matching or profile problem rather than good news. */}
                        <span className="font-semibold" style={{ color: STAGE.approved.color }}>
                          {emptyCount} {emptyCount === 1 ? "has" : "have"} an empty pipeline
                        </span>
                      </>
                    )}
                  </span>
                </div>

                {quiet.length === 0 ? (
                  <p className="text-[11.5px] text-ink-subtle">Every client on the roster needs something today.</p>
                ) : (
                  <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5 xl:auto-rows-[118px]">
                    {quiet.map((r) => (
                      <QuietCard key={r.id} row={r} />
                    ))}
                  </div>
                )}
              </>
            )}
          </>
        )}
      </div>
    </div>
  );
}

function Tab({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={cn(
        "inline-flex h-7 items-center gap-1.5 rounded-[7px] px-[13px] text-[12.5px] transition-colors duration-[120ms]",
        active ? "bg-white font-semibold text-brand-navy shadow-card" : "font-medium text-ink-muted hover:text-brand-navy",
      )}
    >
      {children}
    </button>
  );
}

function Key({ color, children }: { color: string; children: React.ReactNode }) {
  return (
    <span className="inline-flex items-center gap-[5px]">
      <span aria-hidden="true" className="h-[7px] w-[7px] rounded-[2px]" style={{ backgroundColor: color }} />
      {children}
    </span>
  );
}

// The stage bar. `muted` swaps the whole scale for its desaturated twin — see the note
// at the top of the file. Stages with no cards are dropped rather than collapsed to a
// hairline: this is a summary at 5px tall, not the dashboard's five-slot funnel, and
// hairline stubs at this size read as rendering artefacts.
function StageBar({ counts, muted }: { counts: Record<PipelineStageKey, number>; muted?: boolean }) {
  const segments = BAR_ORDER.filter((k) => (counts[k] ?? 0) > 0);
  if (segments.length === 0) return null;
  return (
    <div className="flex h-[5px] gap-[2px]" aria-hidden="true">
      {segments.map((k) => (
        <div
          key={k}
          className="rounded-full"
          style={{ flexGrow: counts[k], flexBasis: 0, backgroundColor: muted ? STAGE[k].muted : STAGE[k].color }}
        />
      ))}
    </div>
  );
}

const REASON_STYLE: Record<ActionReason, { tint: string; color: string; icon: typeof Layers; trailing: typeof ArrowRight }> = {
  alerts: { tint: "rgba(228,118,31,0.10)", color: STAGE.triage.color, icon: Layers, trailing: ArrowRight },
  deadline: { tint: STAGE.client.tint, color: STAGE.client.text, icon: Clock, trailing: ArrowRight },
  question: { tint: "rgba(46,125,145,0.09)", color: STAGE.approved.color, icon: MessageSquare, trailing: CornerUpLeft },
};

function reasonText(r: PortfolioRow): string {
  if (r.reason === "question") {
    return `${r.questions} ${r.questions === 1 ? "question" : "questions"} waiting`;
  }
  if (r.reason === "deadline") {
    const when = r.deadlineDate ? format(parseISO(r.deadlineDate), "MMM d") : "Deadline";
    const overdue = r.deadlineDays !== null && r.deadlineDays < 0;
    return overdue ? `${when} · overdue` : `${when} · ${r.deadlineDays}d out`;
  }
  // Deliberately no age ("oldest sat 41 days" in the design): review_cards has no
  // created_at, so the age of a waiting alert is not recoverable. The count is real;
  // the age would have been invented.
  return `${r.alerts} waiting for review`;
}

function ActionCard({ row }: { row: PortfolioRow }) {
  const style = REASON_STYLE[row.reason ?? "alerts"];
  const Icon = style.icon;
  const Trailing = style.trailing;
  const alertsHot = row.alerts >= ALERTS_THRESHOLD;
  const deadlineHot = row.deadlineDays !== null;
  return (
    <Link
      href={`/clients/${row.id}`}
      className="flex flex-col overflow-hidden rounded-2xl border-t-[3px] bg-white shadow-card transition-shadow duration-[140ms] hover:shadow-card-hover"
      // Teal marks a waiting person, orange marks a waiting queue or clock. With
      // questions unbuilt the teal branch never fires today — it is kept so the card
      // needs no change when they land.
      style={{ borderTopColor: row.reason === "question" ? STAGE.approved.color : STAGE.triage.color }}
    >
      <div className="flex items-center gap-2.5 px-[15px] pt-3">
        <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-pill bg-brand-navy text-[11.5px] font-semibold text-white">
          {initials(row.name)}
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-semibold text-brand-navy">{row.name}</span>
          <span className="mt-0.5 block truncate text-[11px] capitalize text-ink-subtle">{row.subtitle}</span>
        </span>
        <ChevronRight className="h-[15px] w-[15px] shrink-0 text-ink-faint" aria-hidden="true" />
      </div>

      <div className="mx-[15px] mt-[11px] flex items-center border-y border-hairline py-[9px]">
        <span className="flex-1">
          <span
            className="block text-[17px] font-semibold leading-none tabular-nums"
            style={{ color: alertsHot ? STAGE.triage.color : INK.muted }}
          >
            {row.alerts}
          </span>
          <span className="mt-1 block text-[10.5px] text-ink-subtle">alerts</span>
        </span>
        <span className="flex-1">
          <span
            className="block text-[17px] font-semibold leading-none tabular-nums"
            style={{ color: deadlineHot ? STAGE.client.text : INK.subtle }}
          >
            {row.deadlineDays !== null ? `${row.deadlineDays}d` : "—"}
          </span>
          <span className="mt-1 block text-[10.5px] text-ink-subtle">
            {row.deadlineDate ? format(parseISO(row.deadlineDate), "MMM d") : "no deadline"}
          </span>
        </span>
        {/* Questions are unbuilt, so this renders in the design's own inactive state
            rather than being omitted — the slot is real, it just has nothing in it. */}
        <span
          className="flex h-[30px] w-[30px] shrink-0 items-center justify-center rounded-pill"
          style={{ backgroundColor: row.questions > 0 ? "rgba(46,125,145,0.12)" : STAGE.passed.tint }}
          title={row.questions > 0 ? undefined : "Client questions are not available yet"}
        >
          <MessageSquare
            className="h-4 w-4"
            style={{ color: row.questions > 0 ? STAGE.approved.color : INK.faint }}
            aria-hidden="true"
          />
        </span>
      </div>

      <div className="px-[15px] pt-2.5">
        <StageBar counts={row.counts} />
        <p className="mt-2 text-[11px] text-ink-subtle">
          {row.totalGrants} {row.totalGrants === 1 ? "grant" : "grants"} ·{" "}
          {row.inPursuit > 0 ? `${row.inPursuit} in pursuit` : "none in pursuit"}
        </p>
      </div>

      <div className="mt-auto px-3 pb-3">
        <span
          className="flex items-center gap-[9px] rounded-pill px-[11px] py-[9px]"
          style={{ backgroundColor: style.tint }}
        >
          <Icon className="h-3.5 w-3.5 shrink-0" style={{ color: style.color }} aria-hidden="true" />
          <span className="min-w-0 flex-1 truncate text-[11.5px] text-brand-navy">{reasonText(row)}</span>
          <Trailing className="h-3.5 w-3.5 shrink-0" style={{ color: style.color }} aria-hidden="true" />
        </span>
      </div>
    </Link>
  );
}

function QuietCard({ row }: { row: PortfolioRow }) {
  return (
    <Link
      href={`/clients/${row.id}`}
      className="flex flex-col rounded-2xl bg-white p-[13px] shadow-card transition-shadow duration-[140ms] hover:shadow-card-hover"
    >
      <span className="flex items-center gap-[9px]">
        <span
          className={cn(
            "flex h-[26px] w-[26px] shrink-0 items-center justify-center rounded-md text-[10px] font-semibold",
            row.isProspect ? "bg-brand-orange/[0.14] text-brand-orange" : "bg-brand-navy/[0.07] text-ink-muted",
          )}
        >
          {initials(row.name)}
        </span>
        <span className="min-w-0 flex-1">
          <span className="flex min-w-0 items-center gap-1.5">
            <span className="truncate text-[13px] font-semibold text-brand-navy">{row.name}</span>
            {row.isProspect && (
              <span className="shrink-0 rounded-full bg-brand-orange/10 px-1.5 py-px text-[9.5px] font-semibold text-brand-orange">
                Prospect
              </span>
            )}
          </span>
          <span className="mt-px block truncate text-[10.5px] capitalize text-ink-subtle">{row.subtitle}</span>
        </span>
      </span>

      <span className="mt-auto block">
        <StageBar counts={row.counts} muted />
      </span>

      <span className="mt-2 flex items-center gap-2 text-[11px] tabular-nums">
        <span style={{ color: row.alerts > 0 ? INK.muted : INK.subtle }}>
          {row.emptyPipeline ? "no grants yet" : row.alerts > 0 ? `${row.alerts} alerts` : "nothing pending"}
        </span>
        <span className="ml-auto text-ink-subtle">
          {row.deadlineDate ? format(parseISO(row.deadlineDate), "MMM d") : "no deadline"}
        </span>
      </span>
    </Link>
  );
}
