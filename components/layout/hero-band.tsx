// Shared map-backed navy hero band — the header treatment for the client
// dashboard AND the Grant Report, so the two match exactly. The map photo sits
// behind a navy wash (texture, not a competing photo); title + optional right-side
// actions + a divider-separated stat row sit on top.

export interface HeroStat {
  value: React.ReactNode;
  label: string;
  sub?: string | null;
  accent?: boolean;
}

export function HeroBand({
  title,
  subtitle,
  right,
  stats,
}: {
  title: string;
  subtitle?: React.ReactNode;
  right?: React.ReactNode;
  stats: HeroStat[];
}) {
  return (
    <div className="relative overflow-hidden rounded-3xl shadow-lift">
      <div
        aria-hidden
        className="absolute inset-0"
        style={{
          backgroundImage: "url('/map-bg.jpg')",
          backgroundSize: "cover",
          backgroundPosition: "center",
          filter: "grayscale(0.35) blur(1px)",
          transform: "scale(1.02)",
        }}
      />
      <div aria-hidden className="absolute inset-0" style={{ background: "linear-gradient(120deg, rgba(8,22,39,0.94), rgba(11,30,58,0.80))" }} />
      <div className="relative px-8 py-7 text-white">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="min-w-0">
            <h1 className="font-serif text-[32px] font-semibold leading-tight tracking-tight">{title}</h1>
            {subtitle && <p className="mt-1 text-[14px] text-white/70">{subtitle}</p>}
          </div>
          {right}
        </div>
        {stats.length > 0 && (
          <div className="mt-6 flex flex-col gap-5 border-t border-white/[0.14] pt-5 sm:flex-row sm:gap-0">
            {stats.map((s, i) => (
              <div key={i} className={`sm:flex-1 ${i > 0 ? "sm:border-l sm:border-white/[0.14] sm:pl-6" : ""}`}>
                <p className={`text-[26px] font-semibold leading-none ${s.accent ? "text-brand-orange" : "text-white"}`}>{s.value}</p>
                <p className="mt-1.5 text-[11px] font-semibold uppercase tracking-[0.1em] text-white/60">{s.label}</p>
                {s.sub && <p className="mt-0.5 text-[12px] text-white/50">{s.sub}</p>}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
