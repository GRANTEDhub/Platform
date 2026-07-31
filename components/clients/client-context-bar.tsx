import Link from "next/link";
import { ChevronRight } from "lucide-react";

// The client identity bar — a full-bleed white strip under the command band, replacing
// the navy HeroBand on the staff console.
//
// It exists because the band above it is global (which module am I in) and says nothing
// about which client you are looking at. The old navy hero answered that but also
// carried the four stat tiles, and those are now the pipeline's job — so what is left
// is identity and the two actions, which is a 60px strip rather than a 180px banner.
//
// Full-bleed on purpose: it is chrome continuous with the command band, so it is
// rendered OUTSIDE the dashboard's max-w-7xl content column.
export function ClientContextBar({
  name,
  monogram,
  statusChip,
  meta,
  actions,
  backHref,
  backLabel,
}: {
  name: string;
  // Two letters, pre-derived by the caller so this component does no parsing.
  monogram: string;
  statusChip?: React.ReactNode;
  // Already-joined descriptor line (org type · city, state · client-since). Joined by
  // the caller because only it knows which facts exist for this record.
  meta?: string | null;
  actions?: React.ReactNode;
  backHref: string;
  backLabel: string;
}) {
  return (
    <div className="flex min-h-[60px] flex-wrap items-center gap-x-3 gap-y-2 border-b border-hairline-strong bg-white px-[34px] py-3">
      <Link
        href={backHref}
        className="flex shrink-0 items-center gap-0.5 rounded-md text-[12.5px] text-ink-subtle transition-colors hover:text-brand-navy focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-orange/60 focus-visible:ring-offset-2"
      >
        {backLabel}
        <ChevronRight className="h-3.5 w-3.5" aria-hidden="true" />
      </Link>

      <span
        aria-hidden="true"
        className="flex h-[30px] w-[30px] shrink-0 items-center justify-center rounded-md bg-brand-navy text-[11px] font-semibold text-white"
      >
        {monogram}
      </span>

      <h1 className="min-w-0 truncate font-serif text-[19px] font-bold tracking-[-0.01em] text-brand-navy">{name}</h1>

      {statusChip}

      {meta && <p className="min-w-0 truncate text-[12.5px] text-ink-subtle">{meta}</p>}

      {actions && <div className="ml-auto flex shrink-0 items-center gap-2">{actions}</div>}
    </div>
  );
}
