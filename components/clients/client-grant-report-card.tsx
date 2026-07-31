import Link from "next/link";
import { ArrowRight } from "lucide-react";
import { Card } from "@/components/ui/card";
import { FIT_BAND } from "@/lib/report/shape";

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
// Labels come from FIT_BAND, the same map the Grant Report and the staff review
// bands read, so a score reads as the same word everywhere in the product.

export interface DashReportRow {
  cardId: string;
  title: string;
  funder: string | null;
  fitScore: 1 | 2 | 3;
  // Pre-formatted by the caller (it owns the date library + the client's locale
  // expectations); null when the grant carries no deadline.
  deadline: string | null;
  href: string | null;
}

// Ordinal chip: the score AND the word. The number alone is meaningless to a client
// who has not been told the scale, and the word alone loses the ranking.
const TONE: Record<"strong" | "good" | "fair", string> = {
  strong: "bg-brand-orange/10 text-brand-orange",
  good: "bg-brand-navy/[0.07] text-brand-navy",
  fair: "bg-ink-subtle/10 text-ink-subtle",
};

export function ClientGrantReportCard({
  rows,
  total,
  reportHref,
  emptyNote,
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
}) {
  return (
    <Card className="p-6 shadow-grounded sm:p-7">
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
