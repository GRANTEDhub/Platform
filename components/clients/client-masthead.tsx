import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { BRAND, STAGE, STAGE_ON_INK } from "@/lib/brand";
import { BacklogSparkline } from "@/components/clients/backlog-sparkline";
import type { BookRollup } from "@/lib/clients/dashboard-summary";
import type { BacklogTrend } from "@/lib/clients/backlog";

// The client masthead — identity, actions, and the whole pipeline, on one band of ink.
//
// IT REPLACES TWO THINGS: the white identity strip (ClientContextBar) and the pipeline
// card that sat under it. The design's argument is that a client's funnel is not a card
// on the page, it IS the summary of the page, so it belongs in the chrome rather than
// competing with the cards below for the reader's first look. Collapsing the two also
// buys back roughly 90px, which is most of what makes 1440×900 fit without scrolling.
//
// THE ARRANGEMENT IS THE PORTFOLIO'S, EXACTLY: four display figures, divider, a compact
// pipeline block that flexes to fill, divider, the backlog sparkline pinned right. An
// earlier pass built the five stages as full-width cells instead, which turned the strip
// into a row of six equal things with no hierarchy and no reason to look at any of them
// first. The four figures are the answers; the pipeline is the shape behind them.
//
// THE SPARKLINE IS LOAD-BEARING. Without it the pipeline block expands into that space
// and the row reads unbalanced — which is exactly why it must be real rather than drawn.
// See lib/clients/backlog.ts: the series is reconstructed from timestamps that already
// exist, so it needs no snapshot table. When it cannot be reconstructed, it and its
// divider drop together rather than a flat placeholder going in.
//
// COLOUR IS SIGNAL, NOT CATEGORY — orange for what is owed, a neutral ramp for everything
// past it. See STAGE_ON_INK in lib/brand.ts for why the stage palette is deliberately not
// used here, and for the one collision the mockup leaves unresolved.

export function ClientMasthead({
  name,
  meta,
  statusLabel,
  variant = "console",
  book,
  decided,
  nextDeadlineDays,
  backlog,
  nextDeadlineLabel,
  backHref,
  backLabel,
  actions,
  portalFigures,
}: {
  name: string;
  // Already-joined descriptor (org type · city, state · client since). Joined by the
  // caller because only it knows which facts exist for this record.
  meta: string | null;
  statusLabel: string;
  // WHOSE FUNNEL THIS IS. Same construction, same positions, different four figures --
  // one component rather than two so a change to the masthead lands on both surfaces.
  //
  // The console's figures are internal by definition: "Unassessed" MEANS pending our
  // review, and the money estimate and "Portfolio assessed" are our throughput. A client
  // must not be shown any of the three, so `portal` swaps all four for facts about their
  // own decisions and drops the backlog sparkline, which measures us and not them.
  variant?: "console" | "portal";
  // Required when variant="portal". The client's own four counts, computed by the page
  // because only it knows the client-side predicates (see lib/clients/pipeline.ts).
  portalFigures?: { alerts: number; inReport: number; approved: number };
  book: BookRollup;
  // Committed to: approved plus in-pursuit. Passed is NOT decided here — it is a closed
  // decision, and counting it would make a client who was mostly rejected look mostly
  // actioned. Same definition the Grant Report card's "decided" metric uses.
  decided: number;
  // Whole days to the client's soonest upcoming deadline; null when they have none.
  nextDeadlineDays: number | null;
  // Null when the series cannot be reconstructed (nothing placeable in time).
  backlog: BacklogTrend | null;
  // Nearest REAL deadline, pre-formatted. The design's line here reads "triage window
  // closes {date}"; no triage-window field exists and a fabricated date must never ship
  // on a surface staff quote to a client, so the slot carries a deadline we can stand
  // behind and names it. Null drops the clause entirely.
  nextDeadlineLabel: string | null;
  backHref: string;
  backLabel: string;
  actions?: React.ReactNode;
}) {
  const unassessed = book.stages.find((s) => s.key === "triage");
  const segments = book.stages.filter((s) => s.count > 0);
  // Two gates, and both are about not drawing a chart that says nothing. `drawable`
  // requires actual shape across the weeks — a client whose whole backlog appeared
  // yesterday has one spike and seven baselines, which reads as a broken chart rather
  // than as new work. The unplaceable check keeps it from charting whichever subset
  // happens to have engine history, which is a different quantity.
  const showBacklog =
    variant === "console" && backlog !== null && backlog.drawable && backlog.unplaceable <= book.total / 2;

  return (
    <div className="relative z-[1] shrink-0 bg-brand-chrome px-[34px] pb-3.5">
      <div className="flex flex-wrap items-end justify-between gap-x-6 gap-y-3 pb-[9px] pt-2.5">
        <div className="min-w-0">
          <div className="flex items-center gap-[9px]">
            <Link
              href={backHref}
              className="inline-flex items-center gap-1.5 rounded-md text-[11.5px] font-medium text-white/[0.55] transition-colors hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-orange/60 focus-visible:ring-offset-2 focus-visible:ring-offset-brand-chrome"
            >
              <ArrowLeft className="h-[13px] w-[13px]" aria-hidden="true" />
              {backLabel}
            </Link>
            <span aria-hidden="true" className="h-3 w-px bg-white/20" />
            <span
              className="rounded-full px-[9px] py-0.5 text-[10.5px] font-semibold capitalize"
              style={{ backgroundColor: "rgba(74,222,128,0.15)", color: BRAND.successOnDark }}
            >
              {statusLabel}
            </span>
          </div>
          <ClientName name={name} />
          {meta && (
            <p className="mt-[9px] truncate text-[11px] font-semibold uppercase tracking-[0.16em] text-white/50">
              {meta}
            </p>
          )}
        </div>

        <div className="flex shrink-0 flex-wrap items-center gap-2">
          {nextDeadlineLabel && (
            <span className="text-[11.5px] text-white/[0.62]">
              Next deadline <span className="font-semibold text-brand-orange">{nextDeadlineLabel}</span>
            </span>
          )}
          {actions}
        </div>
      </div>

      <div aria-hidden="true" className="h-[2px] bg-brand-orange" />
      <div aria-hidden="true" className="mt-[3px] h-px bg-white/[0.22]" />

      <div className="flex flex-wrap items-end gap-y-4 pt-3">
        {variant === "console" ? (
          <>
            {/* The one figure that carries money, and it carries the estimate marker inline
                rather than in a caption underneath. Award ranges are program-level ceilings,
                not this client's expected receipts — see lib/clients/dashboard-summary.ts. */}
            <Figure
              value={unassessed?.count ?? 0}
              label={unassessed?.money ? `Unassessed · ${unassessed.money} est.` : "Unassessed"}
              color={BRAND.orange}
              className="pr-[26px]"
            />
            <Rule />
            <Figure value={decided} label="Decided" className="px-[26px]" />
            <Rule />
            <Figure value={nextDeadlineDays} suffix="d" label="To next deadline" className="px-[26px]" />
            <Rule />
            <Figure
              value={book.assessedPct}
              suffix="%"
              label="Portfolio assessed"
              color={STAGE.approved.onDark}
              className="px-[26px]"
            />
          </>
        ) : (
          <>
            {/* Orange on the FIRST figure either way, because in both funnels the leading
                figure is the one that is owed — theirs is alerts they have not opened, ours
                is grants we have not assessed. Same signal, different owner. */}
            <Figure
              value={portalFigures?.alerts ?? 0}
              label="Alerts to review"
              color={BRAND.orange}
              className="pr-[26px]"
            />
            <Rule />
            <Figure value={portalFigures?.inReport ?? 0} label="In your report" className="px-[26px]" />
            <Rule />
            <Figure value={nextDeadlineDays} suffix="d" label="To next deadline" className="px-[26px]" />
            <Rule />
            <Figure
              value={portalFigures?.approved ?? 0}
              label="Approved for pursuit"
              color={STAGE.approved.onDark}
              className="px-[26px]"
            />
          </>
        )}
        <Rule />

        <div className="min-w-[280px] flex-1 px-[26px]">
          <div className="flex items-baseline justify-between gap-3">
            <p className="text-[9.5px] font-bold uppercase tracking-[0.14em] text-white/[0.58]">
              {variant === "console" ? "Client pipeline" : "Your grants"} · {book.total}{" "}
              {book.total === 1 ? "grant" : "grants"}
              {/* How much of the money figure above is silent. A $31M pipeline with three
                  unpriced grants is a different fact from one with none, and this is the
                  only line with room to say so. Portal carries no money, so it never fires
                  (rollUpPortal reports unpriced: 0). */}
              {book.unpriced > 0 && ` · ${book.unpriced} unpriced`}
            </p>
            {/* Only with a book to be a percentage OF. At zero grants "100% never
                looked at" is arithmetically true and completely wrong.
                THE SAME FIGURE, DIFFERENT SENTENCE. "never looked at" is a statement about
                OUR assessment rate and aimed at a client reads as an accusation about
                theirs; "still to review" is the same arithmetic said about work in front of
                them. Both are 100 - assessedPct, which on the portal is the share of their
                grants still sitting in alerts. */}
            {book.total > 0 && (
              <p className="shrink-0 text-[11px] text-white/[0.55]">
                <span className="font-semibold text-brand-orange">{100 - book.assessedPct}%</span>{" "}
                {variant === "console" ? "never looked at" : "still to review"}
              </p>
            )}
          </div>
          {/* FIVE keys, not the mockup's four — the drawn legend omits the with-client
              stage, which its sample client happens to have empty. Dropping a real stage
              would stop the bar summing to the total printed beside it. */}
          {segments.length > 0 && (
            <div aria-hidden="true" className="mt-[9px] flex h-[9px] gap-[2px]">
              {segments.map((s) => (
                <div key={s.key} style={{ flexGrow: s.count, flexBasis: 0, backgroundColor: STAGE_ON_INK[s.key] }} />
              ))}
            </div>
          )}
          <div className="mt-2 flex flex-wrap items-center gap-x-3.5 gap-y-1">
            {book.stages
              .filter((s) => s.count > 0)
              .map((s) => (
                <span key={s.key} className="inline-flex items-center gap-[5px] text-[10.5px] text-white/[0.58]">
                  <span aria-hidden="true" className="h-1.5 w-1.5" style={{ backgroundColor: STAGE_ON_INK[s.key] }} />
                  {s.label} {s.count}
                </span>
              ))}
          </div>
        </div>

        {showBacklog && (
          <>
            <Rule />
            <BacklogSparkline trend={backlog} />
          </>
        )}
      </div>
    </div>
  );
}

function Rule() {
  return <span aria-hidden="true" className="h-11 w-px shrink-0 bg-white/[0.16]" />;
}

// One masthead figure. Libre Baskerville at 40px — the display face carries every number
// on the ink screens, which is what makes them read as a printed ledger rather than a
// dashboard. A null value is a dash, never a zero: "no deadline" and "due today" are
// different facts.
function Figure({
  value,
  suffix,
  label,
  color,
  className,
}: {
  value: number | null;
  suffix?: string;
  label: string;
  color?: string;
  className?: string;
}) {
  const muted = value === null || value === 0;
  return (
    <div className={`shrink-0 ${className ?? ""}`}>
      <p
        className="font-serif text-[40px] font-bold leading-[0.85] tabular-nums"
        style={{ color: muted ? "rgba(255,255,255,0.45)" : (color ?? "#FFFFFF") }}
      >
        {value === null ? "—" : value}
        {value !== null && suffix && <span className="text-[20px] text-white/[0.55]">{suffix}</span>}
      </p>
      <p className="mt-[9px] text-[9.5px] font-bold uppercase tracking-[0.14em] text-white/[0.58]">{label}</p>
    </div>
  );
}

// 30px is the drawn size and it overruns the masthead at around thirty characters —
// "Boston Mountain Rural Health Partnership" is forty. Stepping down beats wrapping:
// a second line pushes the metadata down and costs height the page does not have at
// 900px. Past the step it truncates with the full name on hover.
function ClientName({ name }: { name: string }) {
  const size = name.length > 44 ? "text-[20px]" : name.length > 30 ? "text-[24px]" : "text-[30px]";
  return (
    <h1
      title={name}
      className={`mt-2 truncate font-serif font-bold leading-none tracking-[-0.015em] text-white ${size}`}
    >
      {name}
    </h1>
  );
}
