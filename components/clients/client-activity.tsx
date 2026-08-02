import { format, parseISO } from "date-fns";
import { STAGE } from "@/lib/brand";
import { ACTIVITY_WINDOW_DAYS, type ActivityEvent } from "@/lib/clients/activity";

// The rail's activity card. A timeline of what has moved on this client lately.
//
// HEADED "RECENT ACTIVITY", NOT "SINCE YOU WERE LAST HERE" — the design's phrasing needs
// a per-user last-viewed marker that does not exist. See lib/clients/activity.ts for what
// is derived instead and what a real event stream would add. The rows are real either
// way; only the boundary is a rolling window rather than a visit.
//
// flex-1 is load-bearing, not incidental: this card absorbs the difference in height
// between the rail and the left column so the two bottom out level. On the gridded ground
// a ragged bottom edge is visible in a way it was not on flat cream.
export function ClientActivity({ events }: { events: ActivityEvent[] }) {
  return (
    <section className="flex min-h-0 flex-1 flex-col rounded-sharp border border-edge bg-white px-[18px] pb-3.5 pt-[15px]">
      <div className="flex items-baseline justify-between gap-2.5">
        <h2 className="text-[10px] font-bold uppercase tracking-[0.13em] text-ink-muted">Recent activity</h2>
        <p className="shrink-0 text-[11px] text-ink-muted">Last {ACTIVITY_WINDOW_DAYS} days</p>
      </div>

      {events.length === 0 ? (
        <p className="mt-3 text-[11.5px] leading-[1.5] text-ink-muted">
          Nothing has moved on this client in the last {ACTIVITY_WINDOW_DAYS} days.
        </p>
      ) : (
        <ol className="mt-[11px] flex flex-col">
          {events.map((e, i) => (
            <li key={e.id} className={`flex gap-[11px] ${i === events.length - 1 ? "" : "pb-[11px]"}`}>
              <div aria-hidden="true" className="flex w-2 shrink-0 flex-col items-center">
                <span
                  className="mt-1 h-[7px] w-[7px] rounded-full"
                  style={{ backgroundColor: STAGE[e.tone].color }}
                />
                {i < events.length - 1 && <span className="mt-[3px] w-px flex-1 bg-brand-navy/10" />}
              </div>
              <div className="min-w-0 flex-1">
                <p className="text-[12.5px] font-medium leading-[1.4] text-brand-navy">{e.title}</p>
                <p className="mt-0.5 truncate text-[11px] text-ink-muted">
                  {[e.detail, format(parseISO(e.at), "MMM d")].filter(Boolean).join(" · ")}
                </p>
              </div>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
