import Link from "next/link";
import { ArrowRight } from "lucide-react";
import { Card } from "@/components/ui/card";
import { FIT_BAND } from "@/lib/report/shape";
import { BRAND, INK, STAGE } from "@/lib/brand";
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
  // How long ago matching last produced a card for this client, pre-formatted ("4h ago").
  // The design's "Updated 4h ago". Null when the client has never been matched.
  freshness?: string | null;
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
// Ink treatment: squared corner, a 1px LINE.edge rule, no shadow — plus the 3px
// approved-stage top edge, the one accent the design keeps.
//
// TEAL IS RESERVED. It used to carry this card's eyebrow, its strip and its button, which
// made it read as the card's brand colour. On the ink screens teal means exactly one
// thing — a person is waiting on you — so everywhere else it goes neutral or navy. The
// top edge survives because it is a STAGE marker, not decoration; the row dots are the
// same scale for the same reason.
//
// "STANDING WORKSPACE" says what the surface IS — the place staff live all day — which is
// why it shows real rows rather than a counter.
//
// "Updated {n}h ago" is real now. review_cards still has no updated_at, but match_attempts
// records when the engine last carded a pair for this client, which is exactly when this
// list last changed. The caller formats it; null when the client has never been matched,
// and the slot drops rather than saying "now" (which the page's own render time would
// always have said).
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
      className="flex flex-col overflow-hidden rounded-sharp border border-edge bg-white"
      style={{ borderTopWidth: "3px", borderTopColor: STAGE.approved.color }}
    >
      <div className="flex items-start justify-between gap-3.5 px-5 pb-3 pt-4">
        <div>
          <p className="text-[10px] font-bold uppercase tracking-[0.13em] text-ink-muted">
            Standing workspace
          </p>
          <h2 className="mt-[7px] font-serif text-[18px] font-bold text-brand-navy">Grant Report</h2>
        </div>
        {metrics && (
          <div className="flex shrink-0 gap-4 text-right">
            <Metric value={String(metrics.open)} label="open" />
            <Metric value={String(metrics.decided)} label="decided" />
            {/* The denominator is not decoration: a bare "2.1" means nothing without the
                scale, and the scale here is 3, not the 4 the mockup draws. Fit is the
                engine's 1–3 ordinal. */}
            {metrics.avgFit && <Metric value={metrics.avgFit} denominator="/3" label="avg fit" />}
          </div>
        )}
      </div>

      {rows.length === 0 ? (
        <p className="px-5 pb-5 text-sm text-ink-subtle">{emptyNote}</p>
      ) : (
        <>
          <div
            className="flex items-center justify-between gap-2.5 border-y border-hairline px-5 py-[7px]"
            style={{ backgroundColor: "rgba(11,30,58,0.035)" }}
          >
            <p className="text-[10px] font-bold uppercase tracking-[0.11em] text-ink-muted">
              Highest fit right now
            </p>
            {metrics?.freshness && (
              <p className="shrink-0 text-[11px] text-ink-muted">Updated {metrics.freshness}</p>
            )}
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
              className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-sharp bg-brand-navy px-3.5 text-[12.5px] font-semibold text-white transition-opacity duration-[120ms] hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-orange/60 focus-visible:ring-offset-2"
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

// Libre Baskerville, like every other display figure on the ink screens. The denominator
// stays in the body face and a step down, so the figure reads first and the scale reads
// second rather than the two competing.
function Metric({ value, denominator, label }: { value: string; denominator?: string; label: string }) {
  return (
    <div>
      <p className="font-serif text-[21px] font-bold leading-none tabular-nums text-brand-navy">
        {value}
        {denominator && <span className="font-sans text-[12px] font-medium text-ink-muted">{denominator}</span>}
      </p>
      <p className="mt-[3px] text-[10.5px] text-ink-subtle">{label}</p>
    </div>
  );
}

function ConsoleReportRow({ row }: { row: DashReportRow }) {
  const stage = row.stage ?? "triage";
  const meta = [row.funder, row.amount, row.stageLabel?.toLowerCase()].filter(Boolean).join(" · ");
  // Overdue is its own state, not a negative countdown. This card lists every OPEN card
  // including ones whose deadline has passed -- staff still need to see them, so the row
  // is not dropped the way it is from the rail and the pipeline header (where an overdue
  // date presented as the "next deadline" would be wrong). But "-3 days" is not a
  // duration, so it is named instead of counted.
  const days = row.days ?? null;
  const overdue = days !== null && days < 0;
  const urgent = days !== null && days <= URGENT_DAYS;
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
        <p className="text-[13px] font-semibold tabular-nums text-brand-navy">
          {row.fitScore}
          <span className="text-[10.5px] font-medium text-ink-muted">/3</span>
        </p>
        {days !== null && (
          <p
            className="mt-0.5 text-[11px] tabular-nums"
            // Urgent days are small orange text on white, which brand orange cannot
            // carry — BRAND.orangeDeep is the on-light variant. See lib/brand.ts.
            style={{ color: urgent ? BRAND.orangeDeep : INK.subtle, fontWeight: urgent ? 600 : 400 }}
          >
            {overdue ? "Overdue" : `${days} ${days === 1 ? "day" : "days"}`}
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
