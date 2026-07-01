import type { LucideIcon } from "lucide-react";

// A prominent dashboard stat tile: soft-shadowed floating card, icon in a tinted
// chip, a large serif number, a quiet label. The visual anchor of the top of the
// client dashboard.
export function StatCard({
  icon: Icon,
  value,
  label,
}: {
  icon: LucideIcon;
  value: string;
  label: string;
}) {
  return (
    <div className="rounded-2xl bg-white p-5 shadow-[0_2px_8px_rgba(11,30,58,0.06),0_14px_34px_-16px_rgba(11,30,58,0.22)]">
      <div className="flex items-center gap-3">
        <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-brand-orange/10 text-brand-orange">
          <Icon className="h-5 w-5" strokeWidth={2} />
        </span>
        <div className="min-w-0">
          <p className="font-serif text-2xl font-semibold leading-none text-brand-navy">{value}</p>
          <p className="mt-1.5 truncate text-xs text-muted-foreground">{label}</p>
        </div>
      </div>
    </div>
  );
}
