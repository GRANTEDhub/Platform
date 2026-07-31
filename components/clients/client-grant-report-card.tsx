import Link from "next/link";
import { ArrowRight } from "lucide-react";
import { Card } from "@/components/ui/card";
import { FIT_BAND } from "@/lib/report/shape";
import { INK, STAGE } from "@/lib/brand";
import type { PipelineStageKey } from "@/lib/clients/pipeline";

// The Grant Report card — the top of the client's scored matches, on the dashboard
// itself rather than behind a shortcut tile.
//
// WHY IT REPLACES THE SHORTCUT TILE: the tile was a labelled door. It said "Grant
// Report — review your matched opportunities" whether there were nine matches or
// none, so the dashboard could never answer the first question anyone actually has
// ("what did you find for me?") without a navigation. This card answers it in place
// and still links through.
//
// Fit is the engine's 1–3 ORDINAL, never a percentage and never a decimal — a seat
// ceiling (prime → 3, supporting → 2, adjacency → 1) with strength placed inside it.
// The approved design shows fit values like "3.4"; those are not representable and are
// NOT reproduced. Per-row fit stays an integer. The one legitimate decimal is the
// header's mean across rows, which is an average of ordinals and is labelled as one.
//
// TWO VARIANTS, for the same reason ClientDashboard has two bodies: this card renders in
// the staff console AND in the client portal. "console" is the approved design;
// "portal" is what the portal has been shipping. The portal's chip carries the score AND
// the word from FIT_BAND, because a bare numeral is meaningless to a client who has not
// been told the scale — the console can assume its reader knows it.

export interface DashReportRow {
  cardId: string;
  title: string;
  funder: string | null;
  fitScore: 1 | 2 | 3;
  // Pre-formatted by the caller (it owns the date library + the client's locale
  // expectations); null when the grant carries no deadline.
  deadline: string | null;
  href: string | null;
  // ── console only ──
  // Award range, pre-formatted AND already estimate-labelled by the caller. Award
  // figures are estimates unless the NOFO is explicit, and an unlabelled figure on a
  // staff surface is one that gets quoted to a client as fact.
  amount?: string | null;
  // Which funnel stage this card sits at — drives the row's dot colour so the card and
  // the pipeline above it agree.
  stage?: PipelineStageKey;
  stageLabel?: string | null;
  // Whole days to the deadline. Null when undated. Drives the ≤7-day urgency colour,
  // which a pre-formatted date string cannot.
  days?: number | null;
}

export interface DashReportMetrics {
  open: number;
  decided: number;
  // Mean fit across the live set, to one decimal. Null when there is nothing to average
  // — "0.0 avg fit" would read as "we scored everything at zero".
  avgFit: string | null;
}

// Ordinal chip: the score AND the word. The number alone is meaningless to a client
// who has not been told the scale, and the word alone loses the ranking.
const TONE: Record<"strong" | "good" | "fair", string> = {
  strong: "bg-brand-orange/10 text-brand-orange",
  good: "bg-brand-navy/[0.07] text-brand-navy",
  fair: "bg-ink-subtle/10 text-ink-subtle",
};

const URGENT_DAYS = 7;

export function ClientGrantReportCard({
  rows,
  total,
  reportHref,
  emptyNote,
  variant = "portal",
  metrics,
}: {
  // Already sorted and truncated by the caller — it knows the audience's visibility
  // rules (an account-managed client must not see unreleased cards at all).
  rows: DashReportRow[];
  // Every live match, not just the ones shown, so the footer can say what is behind
  // the link instead of implying these three are all of it.
  total: number;
  reportHref: string;
  // What to say when there is nothing yet — differs by actor ("run matches" for
  // staff vs. "your team is working on it" for the client), so the caller supplies it.
  emptyNote: string;
  variant?: "console" | "portal";
  // Console only. Omitted when there is nothing to count.
  metrics?: DashReportMetrics;
}) {
  if (variant === "console") {
    return (
      <ConsoleReportCard
        rows={rows}
        total={total}
        reportHref={reportHref}
        emptyNote={emptyNote}
        metrics={metrics}
      />
    );
  }

  return (
    <Card className="p-6 shadow-card sm:p-7">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="font-serif text-[20px] font-semibold text-brand-navy">Grant Report</h2>
        {total > 0 && (
          <p className="text-[12.5px] text-ink-subtle">
            <span className="font-medium text-ink-muted">{total}</span> live{" "}
            {total === 1 ? "match" : "matches"}
          </p>
        )}
      </div>

      {rows.length === 0 ? (
        <p className="mt-4 text-sm text-muted-foreground">{emptyNote}</p>
      ) : (
        <>
          <ul className="mt-4 space-y-2">
            {rows.map((r) => (
              <ReportRow key={r.cardId} row={r} />
            ))}
          </ul>
          <Link
            href={reportHref}
            className="mt-4 inline-flex items-center gap-1 rounded-md text-[12.5px] font-semibold text-brand-orange transition-colors hover:text-brand-navy focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-orange/60 focus-visible:ring-offset-2"
          >
            {total > rows.length ? `See all ${total} in the Grant Report` : "Open the Grant Report"}
            <ArrowRight className="h-3.5 w-3.5" aria-hidden="true" />
          </Link>
        </>
      )}
    </Card>
  );
}

// ── Console variant — the approved design ───────────────────────────────────
//
// A 3px approved-stage top edge is the ONE border this card carries (no ring, no second
// shadow): the two-step elevation scale allows a deliberate accent edge, not a general
// border. "STANDING WORKSPACE" says what the surface IS — the place staff live all day —
// which is why it shows real rows rather than a counter.
//
// The design's strip also reads "Updated {n}h ago" on the right. review_cards has no
// updated_at column, so there is nothing honest to put there and the slot is left empty
// rather than filled with the page's render time, which would only ever say "now".
function ConsoleReportCard({
  rows,
  total,
  reportHref,
  emptyNote,
  metrics,
}: {
  rows: DashReportRow[];
  total: number;
  reportHref: string;
  emptyNote: string;
  metrics?: DashReportMetrics;
}) {
  const remaining = Math.max(0, total - rows.length);
  return (
    <section
      className="flex flex-col overflow-hidden rounded-2xl border-t-[3px] bg-white shadow-card"
      style={{ borderTopColor: STAGE.approved.color }}
    >
      <div className="flex items-start justify-between gap-3.5 px-5 pb-3 pt-4">
        <div>
          <p
            className="text-[10px] font-bold uppercase tracking-[0.13em]"
            style={{ color: STAGE.approved.color }}
          >
            Standing workspace
          </p>
          <h2 className="mt-[7px] font-serif text-[18px] font-bold text-brand-navy">Grant Report</h2>
        </div>
        {metrics && (
          <div className="flex shrink-0 gap-4 text-right">
            <Metric value={String(metrics.open)} label="open" />
            <Metric value={String(metrics.decided)} label="decided" />
            {metrics.avgFit && <Metric value={metrics.avgFit} label="avg fit" />}
          </div>
        )}
      </div>

      {rows.length === 0 ? (
        <p className="px-5 pb-5 text-sm text-ink-subtle">{emptyNote}</p>
      ) : (
        <>
          <div
            className="flex items-center justify-between gap-2.5 border-y px-5 py-[7px]"
            style={{ backgroundColor: STAGE.approved.tint, borderColor: "rgba(46,125,145,0.13)" }}
          >
            <p
              className="text-[10px] font-bold uppercase tracking-[0.11em]"
              style={{ color: STAGE.approved.color }}
            >
              Highest fit right now
            </p>
          </div>
          <ul>
            {rows.map((r) => (
              <ConsoleReportRow key={r.cardId} row={r} />
            ))}
          </ul>
          {/* mt-auto: this card is the taller of the side-by-side pair, but if the other
              one ever wins, the footer stays pinned to the bottom instead of floating. */}
          <div className="mt-auto flex items-center justify-between gap-2.5 px-5 py-3">
            <p className="text-[11.5px] text-ink-subtle">
              {remaining > 0 ? `${remaining} more in the full report` : "That is the full report"}
            </p>
            <Link
              href={reportHref}
              className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-pill px-3.5 text-[12.5px] font-semibold text-white transition-opacity duration-[120ms] hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-orange/60 focus-visible:ring-offset-2"
              style={{ backgroundColor: STAGE.approved.color }}
            >
              Open report
              <ArrowRight className="h-3.5 w-3.5" aria-hidden="true" />
            </Link>
          </div>
        </>
      )}
    </section>
  );
}

function Metric({ value, label }: { value: string; label: string }) {
  return (
    <div>
      <p className="text-[18px] font-semibold leading-none tabular-nums text-brand-navy">{value}</p>
      <p className="mt-[3px] text-[10.5px] text-ink-subtle">{label}</p>
    </div>
  );
}

function ConsoleReportRow({ row }: { row: DashReportRow }) {
  const stage = row.stage ?? "triage";
  const meta = [row.funder, row.amount, row.stageLabel?.toLowerCase()].filter(Boolean).join(" · ");
  const urgent = row.days !== null && row.days !== undefined && row.days <= URGENT_DAYS;
  const body = (
    <div className="flex items-center gap-3 border-b border-hairline px-5 py-[11px]">
      <span
        aria-hidden="true"
        className="h-[7px] w-[7px] shrink-0 rounded-[2px]"
        style={{ backgroundColor: STAGE[stage].color }}
      />
      <div className="min-w-0 flex-1">
        <p className="truncate text-[13.5px] font-semibold text-brand-navy">{row.title}</p>
        {meta && <p className="mt-0.5 truncate text-[11.5px] text-ink-subtle">{meta}</p>}
      </div>
      <div className="shrink-0 text-right">
        <p className="text-[13px] font-semibold tabular-nums text-brand-navy">{row.fitScore}</p>
        {row.days !== null && row.days !== undefined && (
          <p
            className="mt-0.5 text-[11px] tabular-nums"
            style={{ color: urgent ? STAGE.triage.color : INK.subtle, fontWeight: urgent ? 500 : 400 }}
          >
            {row.days} {row.days === 1 ? "day" : "days"}
          </p>
        )}
      </div>
    </div>
  );
  return <li>{row.href ? <Link href={row.href} className="block hover:bg-page/60">{body}</Link> : body}</li>;
}

function ReportRow({ row }: { row: DashReportRow }) {
  const band = FIT_BAND[row.fitScore] ?? FIT_BAND[1];
  const meta = [row.funder, row.deadline ? `Due ${row.deadline}` : null].filter(Boolean).join(" · ");
  const body = (
    <div className="flex items-center justify-between gap-4 rounded-md bg-white px-4 py-3 ring-1 ring-brand-navy/[0.08] transition-shadow hover:shadow-card">
      <div className="min-w-0">
        <p className="truncate text-sm font-medium text-brand-navy">{row.title}</p>
        {meta && <p className="mt-0.5 truncate text-[12px] text-ink-subtle">{meta}</p>}
      </div>
      <span
        className={`shrink-0 rounded-full px-2.5 py-1 text-[11px] font-semibold ${TONE[band.tone]}`}
      >
        {row.fitScore}/3 · {band.label}
      </span>
    </div>
  );
  return <li>{row.href ? <Link href={row.href} className="block">{body}</Link> : body}</li>;
}
