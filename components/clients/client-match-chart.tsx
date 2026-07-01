// A simple, legible match-funnel chart for the client dashboard: horizontal bars
// sized by count, one row per outcome. Inline SVG/CSS -- no charting dependency
// (keeps the bundle lean and the look on-brand, in the spirit of simplification).
// Honest empty state when there's no activity yet; fills in as data grows.
export type ChartDatum = { label: string; count: number; color: string };

export function ClientMatchChart({ data }: { data: ChartDatum[] }) {
  const total = data.reduce((s, d) => s + d.count, 0);
  if (total === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        No grant activity yet — matches will chart here as they come in.
      </p>
    );
  }
  const max = Math.max(...data.map((d) => d.count), 1);
  return (
    <div className="space-y-3">
      {data.map((d) => (
        <div key={d.label} className="flex items-center gap-3">
          <span className="w-20 shrink-0 text-xs text-muted-foreground">{d.label}</span>
          <div className="h-6 flex-1 overflow-hidden rounded-full bg-brand-navy/[0.06]">
            <div
              className="h-6 rounded-full transition-all"
              style={{
                width: `${(d.count / max) * 100}%`,
                minWidth: d.count > 0 ? "1.5rem" : 0,
                backgroundColor: d.color,
              }}
            />
          </div>
          <span className="w-6 shrink-0 text-right text-sm font-semibold tabular-nums text-brand-navy">
            {d.count}
          </span>
        </div>
      ))}
    </div>
  );
}
