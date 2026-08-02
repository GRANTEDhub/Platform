import { BRAND } from "@/lib/brand";
import { BACKLOG_WEEKS, type BacklogTrend } from "@/lib/clients/backlog";

// The backlog sparkline, pinned to the right end of an ink masthead.
//
// IT IS NOT DECORATION AND NOT OPTIONAL. Without it the pipeline block expands into the
// space and the whole strip reads unbalanced — that is the design's stated reason for it.
// Which also means it must never be a placeholder: a flat row of bars would be a
// fabricated trend sitting where a real one is promised. It renders only when the series
// is real (see lib/clients/backlog.ts for how it is reconstructed without a snapshot
// table), and the caller drops the divider with it when it does not.
//
// The last two bars are lit because the trend's recent direction is the readable part at
// this size — eight 7px bars cannot carry a precise shape, only "rising" or "falling".
const LIT = 2;
const MAX_H = 24;
// A 2px floor turned a low-count series into a row of dashes on the baseline — eight
// clients with two grants each looked identical to eight with none. 6px is the smallest
// bar that still reads as a bar.
const MIN_H = 6;

export function BacklogSparkline({ trend }: { trend: BacklogTrend }) {
  const peak = Math.max(...trend.points, 1);
  // Direction, not sentiment: a growing backlog is bad and a shrinking one is good, so
  // orange marks growth and the neutral marks everything else. Zero change is neutral.
  const growing = trend.absChange > 0;
  const delta =
    trend.pctChange !== null
      ? `${trend.pctChange > 0 ? "+" : ""}${trend.pctChange}%`
      : trend.absChange > 0
        ? `+${trend.absChange}`
        : null;

  return (
    <div className="shrink-0 pl-[26px]">
      <div className="flex items-baseline gap-[9px]">
        <p className="text-[9.5px] font-bold uppercase tracking-[0.14em] text-white/[0.58]">
          Backlog · {BACKLOG_WEEKS} wks
        </p>
        {delta && (
          <p
            className="text-[10.5px] font-bold tabular-nums"
            style={{ color: growing ? BRAND.orange : "rgba(255,255,255,0.58)" }}
          >
            {delta}
          </p>
        )}
      </div>
      <div aria-hidden="true" className="mt-[9px] flex h-6 items-end gap-1">
        {trend.points.map((n, i) => (
          <div
            key={i}
            className="w-[7px]"
            style={{
              // A zero week still draws a stub rather than nothing: a gap in the row
              // reads as missing data, and "the backlog was empty" is a real reading
              // worth showing.
              height: `${Math.max(MIN_H, Math.round((n / peak) * MAX_H))}px`,
              backgroundColor:
                growing && i >= trend.points.length - LIT ? BRAND.orange : "rgba(255,255,255,0.26)",
            }}
          />
        ))}
      </div>
      <span className="sr-only">
        Untriaged backlog over the last {BACKLOG_WEEKS} weeks, oldest first:{" "}
        {trend.points.join(", ")}.
      </span>
    </div>
  );
}
