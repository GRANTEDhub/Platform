// Thin overall-progress bar shown at the top of each IntellEngine step
// (matches the source design's "Overall Progress" header).
export function IntellEngineProgress({ percent, label }: { percent: number; label?: string }) {
  return (
    <div className="mb-2">
      <div className="flex items-center justify-between text-xs font-medium text-muted-foreground">
        <span>{label ?? "Overall Progress"}</span>
        <span>{percent}% Complete</span>
      </div>
      <div className="mt-1.5 h-2 rounded-full bg-brand-navy/[0.08]">
        <div
          className="h-2 rounded-full bg-brand-intellEngine transition-all"
          style={{ width: `${Math.min(100, Math.max(0, percent))}%` }}
        />
      </div>
    </div>
  );
}
