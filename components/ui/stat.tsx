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
  truncateValue = false,
}: {
  label: string;
  value: React.ReactNode;
  hint?: string;
  icon?: React.ReactNode;
  accent?: boolean;
  tone?: "onLight" | "onHero";
  // onHero only: clip the figure to ONE line (ellipsis). Grant facts fit at 16px so
  // they wrap-free without this; Match-tab facts (proposed role, prime name) are
  // free text of unknown length, so they opt in to truncation + the title tooltip.
  truncateValue?: boolean;
}) {
  if (tone === "onHero") {
    // Tile on the narrowed navy hero. Default: white tile, orange serif figure over
    // a navy label. `accent` (the deadline) inverts to a solid-orange tile with white
    // text at text-base (16px). Grant facts are short enough to fit one line; longer
    // Match-tab facts pass `truncateValue` to clip to one line with a hover tooltip.
    // `hint` is not rendered here (dropped in #106); both props still drive onLight.
    return (
      <div className={cn("rounded-2xl p-4", accent ? "bg-brand-orange" : "bg-white shadow-soft")}>
        <p
          className={cn("font-serif text-base font-semibold leading-tight", truncateValue && "truncate", accent ? "text-white" : "text-brand-orange")}
          title={typeof value === "string" ? value : undefined}
        >
          {value}
        </p>
        <p className={cn("mt-1 truncate text-[10px] font-semibold uppercase tracking-widest", accent ? "text-white/90" : "text-brand-navy")}>{label}</p>
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
