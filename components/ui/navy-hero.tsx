import { cn } from "@/lib/utils";

// Navy-gradient hero header block (visual refresh, epic #92). The heavy navy
// weight of every screen lives here; the body sits on cream in floating cards.
// `children` is an optional content row under the header (e.g. grant stat tiles).
export function NavyHero({
  eyebrow,
  title,
  subtitle,
  actions,
  children,
  className,
}: {
  eyebrow?: React.ReactNode;
  title: React.ReactNode;
  subtitle?: React.ReactNode;
  actions?: React.ReactNode;
  children?: React.ReactNode;
  className?: string;
}) {
  return (
    <section
      className={cn(
        "rounded-4xl bg-gradient-to-br from-brand-navy to-brand-navyDeep p-8 text-white shadow-lift",
        className,
      )}
    >
      <div className="flex items-start justify-between gap-6">
        <div className="min-w-0">
          {eyebrow && (
            <p className="mb-3 text-[11px] font-semibold uppercase tracking-[0.2em] text-brand-orange">{eyebrow}</p>
          )}
          <h1 className="font-serif text-[30px] font-semibold leading-[1.12] tracking-tight">{title}</h1>
          {subtitle && <p className="mt-2.5 text-sm text-white/60">{subtitle}</p>}
        </div>
        {actions && <div className="shrink-0">{actions}</div>}
      </div>
      {children && <div className="mt-7">{children}</div>}
    </section>
  );
}
