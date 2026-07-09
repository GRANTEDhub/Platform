import { cn } from "@/lib/utils";

// Orange, uppercase, letter-spaced section label — the recurring "eyebrow" over
// a content block (visual refresh, epic #92). Lifted out of grant-detail so every
// screen shares one definition.
export function SectionLabel({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <p className={cn("text-[11px] font-semibold uppercase tracking-[0.1em] text-brand-orange", className)}>
      {children}
    </p>
  );
}
