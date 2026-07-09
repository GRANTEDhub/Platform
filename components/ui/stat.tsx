import { cn } from "@/lib/utils";

// Stat tile (visual refresh, epic #92). Two tones:
//   onLight — a floating white card on cream (dashboard KPIs, body stats)
//   onHero  — a translucent tile INSIDE a NavyHero (grant-detail key facts)
// `accent` gives the burnt-orange treatment (e.g. the deadline). `value` is the
// large Source Serif figure; `icon` is an optional chip (onLight only).
export function Stat({
  label,
  value,
  hint,
  icon,
  accent = false,
  tone = "onLight",
}: {
  label: string;
  value: React.ReactNode;
  hint?: string;
  icon?: React.ReactNode;
  accent?: boolean;
  tone?: "onLight" | "onHero";
}) {
  if (tone === "onHero") {
    // White tile floating on the navy hero: orange serif figure on top, navy label
    // beneath. Uniform across all four facts (deadline included). `accent`/`hint` are
    // intentionally NOT applied here -- the sub-label was dropped and every tile reads
    // the same (#106 refinement); both props still drive the onLight tile below.
    return (
      <div className="rounded-2xl bg-white p-5 shadow-soft">
        {/* No `truncate`: award-range / deadline values carry spaces and wrap to a
            second line on a narrow hero rather than clipping the (now-prominent) figure. */}
        <p className="font-serif text-2xl font-semibold leading-tight text-brand-orange" title={typeof value === "string" ? value : undefined}>{value}</p>
        <p className="mt-1 truncate text-[10px] font-semibold uppercase tracking-widest text-brand-navy">{label}</p>
      </div>
    );
  }
  return (
    <div className={cn("rounded-3xl bg-white p-6 shadow-soft", accent && "ring-1 ring-brand-orange/25")}>
      {icon && (
        <div className={cn("mb-4 flex h-9 w-9 items-center justify-center rounded-xl", accent ? "bg-brand-orange/10 text-brand-orange" : "bg-brand-cream text-brand-orange")}>{icon}</div>
      )}
      <p className={cn("text-[10px] font-semibold uppercase tracking-widest", accent ? "text-brand-orange" : "text-muted-foreground")}>{label}</p>
      <p className={cn("mt-1.5 font-serif text-2xl font-semibold leading-none", accent ? "text-brand-orange" : "text-brand-navy")}>{value}</p>
      {hint && <p className="mt-2 text-xs text-muted-foreground">{hint}</p>}
    </div>
  );
}
