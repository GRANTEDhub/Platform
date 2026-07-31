import Link from "next/link";
import { INK, STAGE } from "@/lib/brand";

// "Upcoming deadlines" — the rail's clock. Three rows, soonest first.
//
// It exists because the deadline pressure on a client was previously only legible by
// reading the Grant Report rows and doing the arithmetic per row. The day count is the
// question ("how long have I got"), so it gets the fixed left gutter and the numeral
// gets the weight; the grant title is the answer to "on what", so it follows.
//
// URGENCY IS ONE THRESHOLD, not a gradient: at 7 days or fewer both the numeral and the
// word go orange, otherwise the numeral is ink and the word is subtle. A gradient would
// imply a precision we do not have — a 9-day and an 11-day deadline are the same
// problem.
const URGENT_DAYS = 7;

export interface DashDeadline {
  id: string;
  title: string;
  // "{agency} · {stage}" already joined by the caller, which is the only thing that
  // knows which of the two facts exist for a given card.
  meta: string | null;
  // Whole days remaining. Never negative — the caller drops overdue rows, because an
  // overdue grant is not an "upcoming deadline" and rendering it as one would be wrong.
  days: number;
  href?: string | null;
}

export function UpcomingDeadlines({ deadlines }: { deadlines: DashDeadline[] }) {
  return (
    <section className="rounded-2xl bg-white px-[18px] py-4 shadow-card">
      <h2 className="mb-[11px] text-[10px] font-bold uppercase tracking-[0.13em] text-ink-subtle">
        Upcoming deadlines
      </h2>
      <ul>
        {deadlines.map((d, i) => (
          <Row key={d.id} deadline={d} last={i === deadlines.length - 1} />
        ))}
      </ul>
    </section>
  );
}

function Row({ deadline, last }: { deadline: DashDeadline; last: boolean }) {
  const urgent = deadline.days <= URGENT_DAYS;
  const body = (
    <div className={`flex items-center gap-[11px] py-2 ${last ? "" : "border-b border-hairline"}`}>
      <div className="w-[34px] shrink-0 text-center">
        <p
          className="text-[15px] font-semibold leading-none tabular-nums"
          style={{ color: urgent ? STAGE.triage.color : INK.DEFAULT }}
        >
          {deadline.days}
        </p>
        <p
          className="mt-px text-[9.5px] font-semibold uppercase tracking-[0.06em]"
          style={{ color: urgent ? STAGE.triage.color : INK.subtle }}
        >
          {deadline.days === 1 ? "day" : "days"}
        </p>
      </div>
      <div className="min-w-0 flex-1">
        <p className="truncate text-[12.5px] font-medium text-brand-navy">{deadline.title}</p>
        {deadline.meta && <p className="mt-px text-[11px] text-ink-subtle">{deadline.meta}</p>}
      </div>
    </div>
  );
  return <li>{deadline.href ? <Link href={deadline.href} className="block">{body}</Link> : body}</li>;
}
