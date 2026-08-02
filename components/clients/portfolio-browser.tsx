"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { format, parseISO } from "date-fns";
import { ArrowRight, Clock, CornerUpLeft, Layers, MessageSquare, Plus } from "lucide-react";
import { INK, STAGE, STAGE_ON_INK } from "@/lib/brand";
import { ALERTS_THRESHOLD, DEADLINE_DAYS, type ActionReason, type BookPipeline } from "@/lib/clients/portfolio";
import type { PipelineStageKey } from "@/lib/clients/pipeline";
import { cn } from "@/lib/utils";

// The Portfolio roster, built to the approved design (design/portfolio/, the v4 "Ink"
// mockup). It replaces the card-grid build wholesale — same split, different system.
//
// THE SPLIT IS STILL THE ARGUMENT: large cards for clients asking for something today,
// everyone else as a typographic index. What changed is the second tier. A grid of
// compact cards gave twenty quiet clients the same visual weight class as seven urgent
// ones; an index gives them a line each and lets the cards own the page. The rule that
// decides which tier a client lands in is unchanged and still lives in
// lib/clients/portfolio.ts.
//
// THREE THINGS HERE ARE PAGE-SCOPED, not new system defaults — see lib/brand.ts for the
// full note on each. The ground (SURFACE.ground) is a step darker than every other page;
// cards are squared (RADIUS.sharp) with a 1px LINE.edge rule and NO shadow, where the
// rest of the console is 14px and raised. They coexist because only this page has been
// redrawn in the ink direction. If Design carries it across the console, these collapse
// into the base tokens.
//
// CONTRAST: on SURFACE.ground the small-text floor is INK.muted (#5B6472). INK.subtle
// (#6E7683) clears AA on a white card (4.58:1) and fails on the ground (3.70:1), so
// ground-level type uses muted and card-level labels use subtle. That is why the two look
// inconsistent in the diff — they are answering to different backgrounds.
//
// The masthead is BRAND.chrome (#0A1420), the mockup's value. An earlier pass used
// BRAND.navy to avoid a seam where it meets the global command band; the resolution was
// to repaint the band instead, so both are chrome now and the seam is gone.

export type PortfolioRow = {
  id: string;
  name: string;
  subtitle: string;
  isProspect: boolean;
  alerts: number;
  // Days the longest-waiting alert has been sitting, or null when unknowable (see the
  // page's note — manual adds never went through the engine, so they have no
  // first-surfaced time and the card falls back to the plain count).
  oldestAlertDays: number | null;
  deadlineDays: number | null;
  deadlineDate: string | null;
  questions: number;
  // Step progress on the furthest-along proposal in flight, or null if none. Progress
  // through the scope -> compliance -> build flow, NOT how much narrative is written.
  draftPct: number | null;
  reason: ActionReason | null;
  counts: Record<PipelineStageKey, number>;
  totalGrants: number;
  inPursuit: number;
  emptyPipeline: boolean;
};

type Filter = "all" | "action" | "quiet";

const BAR_ORDER: PipelineStageKey[] = ["triage", "client", "approved", "pursuit", "passed"];

// The book bar uses STAGE_ON_INK — orange for what is owed, a neutral ramp for
// everything past it — NOT the stage palette. This reverses the first build of this
// masthead, which rendered each stage in its own hue. The client dashboard states the
// rule outright: on ink, colour means signal and stage is carried by position and label.
// Two pages that ship together cannot render the same five stages two ways, and a
// full-palette bar makes a settled book as loud as a backlogged one. See lib/brand.ts.

const BOOK_LABEL: Record<PipelineStageKey, string> = {
  triage: "Unassessed",
  client: "With client",
  approved: "Approved",
  pursuit: "In pursuit",
  passed: "Passed",
};

export function PortfolioBrowser({
  rows,
  isAdmin,
  book,
  nextDeadlineDays,
  today,
}: {
  rows: PortfolioRow[];
  isAdmin: boolean;
  book: BookPipeline;
  nextDeadlineDays: number | null;
  // Stamped on the server and passed down, so the masthead's date cannot differ between
  // the server render and the hydrated one.
  today: string;
}) {
  const [filter, setFilter] = useState<Filter>("all");

  const { action, quiet } = useMemo(() => {
    // Alphabetical within each tier. Not most-urgent-first: the split has already done
    // the prioritising, and both tiers are scanned by name once you know who you are
    // looking for. The index in particular is only usable in alphabetical order.
    const byName = (a: PortfolioRow, b: PortfolioRow) => a.name.localeCompare(b.name);
    return {
      action: rows.filter((r) => r.reason !== null).sort(byName),
      quiet: rows.filter((r) => r.reason === null).sort(byName),
    };
  }, [rows]);

  const clientCount = rows.filter((r) => !r.isProspect).length;
  const prospectCount = rows.filter((r) => r.isProspect).length;
  const openAlerts = rows.reduce((n, r) => n + r.alerts, 0);
  const questionsWaiting = rows.reduce((n, r) => n + r.questions, 0);
  const emptyCount = quiet.filter((r) => r.emptyPipeline).length;

  const showAction = filter !== "quiet";
  const showQuiet = filter !== "action";

  return (
    <div className="flex min-h-full flex-col bg-ground">
      <div className="relative z-[1] shrink-0 bg-brand-chrome px-[34px] pb-3.5">
        <div className="flex flex-wrap items-end justify-between gap-x-6 gap-y-3 pb-[11px] pt-3">
          <div>
            <h1 className="font-serif text-[30px] font-bold leading-none tracking-[-0.015em] text-white">
              The Portfolio
            </h1>
            <p className="mt-[9px] text-[11px] font-semibold uppercase tracking-[0.16em] text-white/50">
              {format(parseISO(today), "EEEE, MMMM d, yyyy")}
              {" · "}
              {clientCount} {clientCount === 1 ? "client" : "clients"}
              {prospectCount > 0 && `, ${prospectCount} ${prospectCount === 1 ? "prospect" : "prospects"}`}
            </p>
          </div>

          <div className="flex shrink-0 flex-wrap items-center gap-2">
            <div className="flex items-center gap-[2px] rounded-[9px] bg-white/[0.08] p-[3px]">
              <Tab active={filter === "all"} onClick={() => setFilter("all")}>
                All {rows.length}
              </Tab>
              <Tab active={filter === "action"} onClick={() => setFilter("action")}>
                Requires action
                {action.length > 0 && (
                  <span className="rounded-full bg-brand-orangeFill px-1.5 py-px text-[10px] font-bold leading-[1.3] text-white">
                    {action.length}
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
                className="inline-flex h-8 shrink-0 items-center gap-[7px] rounded-[9px] bg-white px-[14px] text-[13px] font-semibold text-brand-navy transition-opacity duration-[120ms] hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-orange/60 focus-visible:ring-offset-2 focus-visible:ring-offset-brand-chrome"
              >
                <Plus className="h-3.5 w-3.5" aria-hidden="true" />
                Add client
              </Link>
            )}
          </div>
        </div>

        {/* The masthead rule — a thick orange bar over a hairline, the one piece of pure
            typographic furniture on the page. */}
        <div aria-hidden="true" className="h-[2px] bg-brand-orange" />
        <div aria-hidden="true" className="mt-[3px] h-px bg-white/[0.22]" />

        <div className="flex flex-wrap items-end gap-y-4 pt-[13px]">
          <Figure value={openAlerts} label="Open alerts" color={STAGE.triage.color} className="pr-[26px]" />
          <Rule />
          <Figure value={action.length} label="Require action" className="px-[26px]" />
          <Rule />
          {/* Questions are unbuilt (see lib/clients/portfolio.ts), so this is a real zero
              and renders in the muted treatment rather than a lit teal nought. The tile
              is here because the slot is real; it lights up when the feature lands. */}
          <Figure
            value={questionsWaiting}
            label="Questions waiting"
            color={questionsWaiting > 0 ? STAGE.approved.onDark : undefined}
            title={questionsWaiting > 0 ? undefined : "Client questions are not available yet"}
            className="px-[26px]"
          />
          <Rule />
          <Figure
            value={nextDeadlineDays}
            suffix="d"
            label="To next deadline"
            className="px-[26px]"
          />
          <Rule />

          <div className="min-w-[280px] flex-1 px-[26px]">
            <div className="flex items-baseline justify-between gap-3">
              <p className="text-[9.5px] font-bold uppercase tracking-[0.14em] text-white/[0.58]">
                Book pipeline · {book.total} {book.total === 1 ? "grant" : "grants"}
              </p>
              <p className="shrink-0 text-[11px] text-white/[0.55]">
                <span className="font-semibold text-brand-orange">{book.unassessedPct}%</span> never looked at
              </p>
            </div>
            {/* FIVE segments, not the mockup's four — the drawn legend omits the
                with-client stage, which its sample roster happened to have empty, and a
                bar that drops a real stage stops summing to the total printed above it. */}
            <div aria-hidden="true" className="mt-[9px] flex h-[9px] gap-[2px]">
              {BAR_ORDER.filter((k) => book.counts[k] > 0).map((k) => (
                <div key={k} style={{ flexGrow: book.counts[k], flexBasis: 0, backgroundColor: STAGE_ON_INK[k] }} />
              ))}
            </div>
            <div className="mt-2 flex flex-wrap items-center gap-x-3.5 gap-y-1">
              {BAR_ORDER.filter((k) => book.counts[k] > 0).map((k) => (
                <span key={k} className="inline-flex items-center gap-[5px] text-[10.5px] text-white/[0.58]">
                  <span aria-hidden="true" className="h-1.5 w-1.5" style={{ backgroundColor: STAGE_ON_INK[k] }} />
                  {BOOK_LABEL[k]} {book.counts[k]}
                </span>
              ))}
            </div>
          </div>
        </div>
      </div>

      {/* The body carries the page's decoration: three faint vertical rules and an
          oversized figure bled off the bottom-right corner. Both are ornament — the
          rules are set as a fraction of the width rather than aligned to the card grid,
          because at the drawn 1440 they do not line up with it either. overflow-hidden
          is what clips the figure. */}
      <div className="relative flex-1 overflow-hidden px-[34px] pb-3.5 pt-3.5">
        <div aria-hidden="true" className="pointer-events-none absolute inset-0 z-0">
          <span className="absolute inset-y-0 left-[26%] w-px bg-brand-navy/[0.07]" />
          <span className="absolute inset-y-0 left-1/2 w-px bg-brand-navy/[0.07]" />
          <span className="absolute inset-y-0 left-[74%] w-px bg-brand-navy/[0.07]" />
          <span className="absolute inset-y-0 left-0 w-px bg-brand-navy/10" />
          <span className="absolute inset-y-0 right-0 w-px bg-brand-navy/10" />
          <span className="absolute -bottom-[152px] -right-[72px] font-serif text-[340px] font-bold leading-none tracking-[-0.04em] text-brand-navy/[0.03]">
            {openAlerts}
          </span>
        </div>

        <div className="relative z-[1]">
          {rows.length === 0 ? (
            <p className="rounded-sharp border border-edge bg-white px-6 py-12 text-center text-sm text-ink-muted">
              No clients or prospects yet.
            </p>
          ) : (
            <>
              {showAction && (
                <>
                  <div className="flex flex-wrap items-center gap-x-3 gap-y-2 pb-[11px]">
                    <h2 className="font-serif text-[17px] font-bold text-brand-navy">Requires action</h2>
                    <span className="inline-flex h-[19px] items-center rounded-full bg-brand-orangeFill px-2 text-[10.5px] font-bold tabular-nums text-white">
                      {action.length}
                    </span>
                    <span aria-hidden="true" className="h-px flex-1 bg-brand-navy/20" />
                    {/* The legend states the rule the split is made on, so the page
                        explains itself rather than requiring you to infer the thresholds
                        from which cards happen to be up here. */}
                    <div className="flex flex-wrap items-center gap-3.5 text-[11.5px] text-ink-muted">
                      <Key color={STAGE.triage.color}>Alerts ≥ {ALERTS_THRESHOLD}</Key>
                      <Key color={STAGE.client.color}>Deadline ≤ {DEADLINE_DAYS}d</Key>
                      <Key color={STAGE.approved.color}>Question waiting</Key>
                    </div>
                  </div>

                  {action.length === 0 ? (
                    <p className="rounded-sharp border border-edge bg-white/40 px-4 py-3 text-[12.5px] text-ink-muted">
                      Nothing needs you right now — every client is inside their alert and deadline thresholds.
                    </p>
                  ) : (
                    <div className="grid gap-3.5 sm:grid-cols-2 lg:grid-cols-3 xl:auto-rows-[214px] xl:grid-cols-4">
                      {action.map((r) => (
                        <ActionCard key={r.id} row={r} />
                      ))}
                      {/* Closes the grid, and ONLY when it actually closes it: rendered
                          when the cards leave a gap in the last row of the 4-up layout,
                          never when they fill it exactly (which would strand this alone
                          on a fresh row and read as a missing card). */}
                      {action.length % 4 !== 0 && (
                        <div className="hidden flex-col items-center justify-center gap-2 rounded-sharp border border-edge bg-white/[0.42] px-[18px] xl:flex">
                          <p className="font-serif text-[15px] font-bold text-ink-muted">And that&rsquo;s all</p>
                          <p className="text-center text-[11.5px] leading-[1.5] text-ink-muted">
                            {quiet.length > 0
                              ? `The other ${quiet.length} are indexed below and can wait for the sweep`
                              : "Everyone else is settled"}
                          </p>
                        </div>
                      )}
                    </div>
                  )}
                </>
              )}

              {showQuiet && (
                <>
                  <div className="flex flex-wrap items-center gap-x-3 gap-y-2 pb-2 pt-[13px]">
                    <h2 className="font-serif text-[13.5px] font-bold text-ink-muted">No action needed</h2>
                    <span className="text-[11.5px] tabular-nums text-ink-muted">{quiet.length}</span>
                    {emptyCount > 0 && (
                      // Empty is NOT the same as quiet: quiet means the work is done,
                      // empty means nothing was ever found, which is usually a matching
                      // or profile problem rather than good news.
                      <span className="text-[11.5px] font-semibold" style={{ color: STAGE.approved.color }}>
                        {emptyCount} {emptyCount === 1 ? "has" : "have"} an empty pipeline
                      </span>
                    )}
                    <span aria-hidden="true" className="h-px flex-1 bg-brand-navy/20" />
                    <span className="text-[11px] font-semibold uppercase tracking-[0.1em] text-ink-muted">
                      Name · alerts · next deadline
                    </span>
                  </div>

                  {quiet.length === 0 ? (
                    <p className="text-[11.5px] text-ink-muted">Every client on the roster needs something today.</p>
                  ) : (
                    // THREE COLUMNS READ DOWN, not across: the index is alphabetical and
                    // only usable if A-to-Z runs down each column in turn, so the list is
                    // chunked into three and rendered as three stacks. A single grid with
                    // row auto-flow would order it across, which is unreadable.
                    <div className="grid grid-cols-1 gap-x-10 sm:grid-cols-2 lg:grid-cols-3">
                      {columnise(quiet, 3).map((col, i) => (
                        <div key={i} className="flex flex-col">
                          {col.map((r) => (
                            <IndexRow key={r.id} row={r} />
                          ))}
                        </div>
                      ))}
                    </div>
                  )}
                </>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}

// Split into `n` column-major chunks, front-loading the remainder so the columns differ
// by at most one row and the left ones are never shorter than the right.
function columnise<T>(items: T[], n: number): T[][] {
  const out: T[][] = [];
  let start = 0;
  for (let i = 0; i < n; i++) {
    const size = Math.ceil((items.length - start) / (n - i));
    out.push(items.slice(start, start + size));
    start += size;
  }
  return out;
}

function Rule() {
  return <span aria-hidden="true" className="h-11 w-px shrink-0 bg-white/[0.16]" />;
}

// One masthead figure. Libre Baskerville at 40px — the display face carries every number
// on this page, which is what makes it read as a printed ledger rather than a dashboard.
function Figure({
  value,
  suffix,
  label,
  color,
  title,
  className,
}: {
  value: number | null;
  suffix?: string;
  label: string;
  color?: string;
  title?: string;
  className?: string;
}) {
  return (
    <div className={cn("shrink-0", className)} title={title}>
      <p
        className="font-serif text-[40px] font-bold leading-[0.85] tabular-nums"
        style={{ color: color ?? "#FFFFFF" }}
      >
        {value === null ? "—" : value}
        {value !== null && suffix && <span className="text-[20px] text-white/[0.55]">{suffix}</span>}
      </p>
      <p className="mt-[9px] text-[9.5px] font-bold uppercase tracking-[0.14em] text-white/[0.58]">{label}</p>
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
        "inline-flex h-[26px] items-center gap-1.5 rounded-[7px] px-3 text-[12.5px] transition-colors duration-[120ms]",
        active ? "bg-white font-semibold text-brand-navy" : "font-medium text-white/[0.72] hover:text-white",
      )}
    >
      {children}
    </button>
  );
}

function Key({ color, children }: { color: string; children: React.ReactNode }) {
  return (
    <span className="inline-flex items-center gap-[5px]">
      <span aria-hidden="true" className="h-[7px] w-[7px]" style={{ backgroundColor: color }} />
      {children}
    </span>
  );
}

// The per-client stage bar. Stages with no cards are dropped rather than collapsed to a
// hairline: this is a 5px summary, not the dashboard's five-slot funnel, and hairline
// stubs at that size read as rendering artefacts.
function StageBar({ counts }: { counts: Record<PipelineStageKey, number> }) {
  const segments = BAR_ORDER.filter((k) => (counts[k] ?? 0) > 0);
  if (segments.length === 0) return null;
  return (
    <div className="flex h-[5px] gap-[2px]" aria-hidden="true">
      {segments.map((k) => (
        <div
          key={k}
          className="rounded-full"
          style={{ flexGrow: counts[k], flexBasis: 0, backgroundColor: STAGE[k].color }}
        />
      ))}
    </div>
  );
}

const REASON_STYLE: Record<ActionReason, { tint: string; color: string; icon: typeof Layers; trailing: typeof ArrowRight }> = {
  // The strip fills sit a little heavier than the STAGE tints, which are tuned for panel
  // headers behind body text; here the strip IS the emphasis. client snaps to its token
  // (0.13 -> 0.14 is imperceptible); the other two are the design's strip alphas.
  alerts: { tint: "rgba(228,118,31,0.10)", color: STAGE.triage.color, icon: Layers, trailing: ArrowRight },
  deadline: { tint: STAGE.client.tint, color: STAGE.client.text, icon: Clock, trailing: ArrowRight },
  question: { tint: "rgba(46,125,145,0.09)", color: STAGE.approved.color, icon: MessageSquare, trailing: CornerUpLeft },
};

// What the footer strip says. One line per reason, and each says the thing that makes it
// urgent rather than restating the count already printed on the card.
function reasonText(r: PortfolioRow): string {
  if (r.reason === "question") {
    return `${r.questions} ${r.questions === 1 ? "question" : "questions"} waiting`;
  }
  if (r.reason === "deadline") {
    const when = r.deadlineDate ? format(parseISO(r.deadlineDate), "MMM d") : "Deadline";
    if (r.deadlineDays !== null && r.deadlineDays < 0) return `${when} · overdue`;
    // The drawn line pairs the date with the state of the work: "no draft started" or
    // "draft 40%". The percentage is progress through the scope -> compliance -> build
    // flow, the same figure the client dashboard shows as "step N of 4" — it is NOT a
    // claim about how much narrative exists, so it is qualified here too.
    if (r.draftPct === null) return `${when} · no draft started`;
    return `${when} · draft ${r.draftPct}% of the flow`;
  }
  // The drawn line is "Oldest sat 41 days", recovered from the first carded match
  // attempt for each waiting card. Falls back to the plain count when no waiting card
  // has an attempt behind it (manual adds never went through the engine) — the count is
  // always real, the age is shown only when it is.
  if (r.oldestAlertDays !== null) {
    return `Oldest sat ${r.oldestAlertDays} ${r.oldestAlertDays === 1 ? "day" : "days"}`;
  }
  return `${r.alerts} waiting for review`;
}

function ActionCard({ row }: { row: PortfolioRow }) {
  const style = REASON_STYLE[row.reason ?? "alerts"];
  const Icon = style.icon;
  const Trailing = style.trailing;
  const alertsHot = row.alerts >= ALERTS_THRESHOLD;
  const questioned = row.questions > 0;

  return (
    <Link
      href={`/clients/${row.id}`}
      className="flex flex-col overflow-hidden rounded-sharp border border-edge bg-white transition-colors duration-[120ms] hover:border-brand-navy/25"
      // Teal marks a waiting person, orange marks a waiting queue or clock. With
      // questions unbuilt the teal branch never fires today — it is kept so the card
      // needs no change when they land.
      style={{
        borderTopWidth: "3px",
        borderTopColor: row.reason === "question" ? STAGE.approved.color : STAGE.triage.color,
      }}
    >
      <div className="flex items-start gap-3 px-[15px] pt-[13px]">
        {/* The alert count as a display figure, not a stat tile. It is the first thing
            read on the card and the reason the card is on this tier at all. */}
        <div className="w-[52px] shrink-0 text-center">
          <p
            className="font-serif text-[34px] font-bold leading-[0.9] tabular-nums"
            style={{ color: alertsHot ? STAGE.triage.color : INK.subtle }}
          >
            {row.alerts}
          </p>
          <p className="mt-1.5 text-[9px] font-bold uppercase tracking-[0.12em] text-ink-subtle">Alerts</p>
        </div>

        <div className="min-w-0 flex-1 pt-0.5">
          <p className="flex min-w-0 items-center gap-1.5">
            <span className="truncate font-serif text-[15px] font-bold text-brand-navy">{row.name}</span>
            {row.isProspect && <ProspectChip />}
          </p>
          <p className="mt-1 truncate text-[11px] capitalize text-ink-subtle">{row.subtitle}</p>
          <p className="mt-2">
            <DeadlineLine row={row} />
          </p>
        </div>

        {/* Questions are unbuilt, so this renders in the design's own inactive state
            rather than being omitted — the slot is real, it just has nothing in it. */}
        <span
          className="flex h-[26px] w-[26px] shrink-0 items-center justify-center rounded-md"
          style={{ backgroundColor: questioned ? "rgba(46,125,145,0.12)" : "rgba(11,30,58,0.045)" }}
          title={questioned ? undefined : "Client questions are not available yet"}
        >
          <MessageSquare
            className="h-3.5 w-3.5"
            style={{ color: questioned ? STAGE.approved.color : INK.faint }}
            aria-hidden="true"
          />
        </span>
      </div>

      <div className="px-[15px] pt-3">
        <StageBar counts={row.counts} />
        <p className="mt-2 text-[11px] text-ink-subtle">
          {row.totalGrants} {row.totalGrants === 1 ? "grant" : "grants"} ·{" "}
          {row.inPursuit > 0 ? `${row.inPursuit} in pursuit` : "none in pursuit"}
        </p>
      </div>

      <div className="mt-auto px-3 pb-3">
        <span className="flex items-center gap-[9px] rounded-pill px-[11px] py-[9px]" style={{ backgroundColor: style.tint }}>
          <Icon className="h-3.5 w-3.5 shrink-0" style={{ color: style.color }} aria-hidden="true" />
          <span className="min-w-0 flex-1 truncate text-[11.5px] text-brand-navy">{reasonText(row)}</span>
          <Trailing className="h-3.5 w-3.5 shrink-0" style={{ color: style.color }} aria-hidden="true" />
        </span>
      </div>
    </Link>
  );
}

function DeadlineLine({ row }: { row: PortfolioRow }) {
  if (row.deadlineDate === null || row.deadlineDays === null) {
    return (
      <span className="inline-flex items-center gap-1.5 text-[11.5px] text-ink-muted">
        <span aria-hidden="true" className="h-1.5 w-1.5 rounded-full" style={{ backgroundColor: STAGE.passed.muted }} />
        No deadline set
      </span>
    );
  }
  const when = format(parseISO(row.deadlineDate), "MMM d");
  return (
    <span className="inline-flex items-center gap-1.5 text-[11.5px] font-semibold" style={{ color: STAGE.client.text }}>
      <span aria-hidden="true" className="h-1.5 w-1.5 rounded-full" style={{ backgroundColor: STAGE.client.color }} />
      {row.deadlineDays < 0 ? `${when} · overdue` : `${when} · ${row.deadlineDays} ${row.deadlineDays === 1 ? "day" : "days"}`}
    </span>
  );
}

function ProspectChip() {
  return (
    <span
      className="shrink-0 rounded-full bg-brand-orange/[0.11] px-1.5 text-[9.5px] font-semibold text-brand-orange"
      title="Prospect — not yet converted to a client"
    >
      P
    </span>
  );
}

// One line of the index. Name, dot leader, alerts, next deadline — the whole quiet tier
// is this row twenty times, which is the point: a client with nothing to do earns a line,
// not a card.
function IndexRow({ row }: { row: PortfolioRow }) {
  return (
    <Link
      href={`/clients/${row.id}`}
      className="group flex h-[22px] items-baseline gap-[7px] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-brand-orange/60"
    >
      <span className="max-w-[186px] shrink-0 truncate text-[12.5px] font-medium text-brand-navy group-hover:text-brand-orange">
        {row.name}
      </span>
      {row.isProspect && <ProspectChip />}
      <span
        aria-hidden="true"
        className="h-px min-w-[12px] flex-1 -translate-y-[3px]"
        style={{
          background: "repeating-linear-gradient(to right,rgba(11,30,58,.28) 0 1.5px,transparent 1.5px 5px)",
        }}
      />
      <span className="w-4 shrink-0 text-right text-[12.5px] font-semibold tabular-nums text-ink-muted">
        {row.alerts > 0 ? row.alerts : "–"}
      </span>
      <span
        className="w-11 shrink-0 text-right text-[11px] tabular-nums"
        style={{ color: row.deadlineDate ? STAGE.client.deep : INK.muted }}
      >
        {row.deadlineDate ? format(parseISO(row.deadlineDate), "MMM d") : "—"}
      </span>
    </Link>
  );
}
