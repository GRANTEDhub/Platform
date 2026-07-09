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
    return (
      <div className={cn("rounded-3xl p-5", accent ? "bg-brand-orange" : "bg-white/[0.08]")}>
        <p className={cn("truncate text-[10px] font-semibold uppercase tracking-widest", accent ? "text-white/80" : "text-white/50")}>{label}</p>
        <p className="mt-2 truncate font-serif text-2xl font-semibold text-white" title={typeof value === "string" ? value : undefined}>{value}</p>
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
