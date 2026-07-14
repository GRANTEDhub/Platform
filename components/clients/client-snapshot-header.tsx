import Link from "next/link";

// Hero band for the client dashboard: a navy field with a subtle gradient, a
// large cream serif name and a short human line. Presence, not a thin strip.
// Stat tiles live below the hero (they float over its lower edge), so the hero
// itself stays clean.
export function ClientHero({
  name,
  humanLine,
  subLine,
  editHref,
  backHref,
  backLabel,
}: {
  name: string;
  humanLine: string | null;
  subLine: string | null;
  editHref: string;
  // Contextual "up" link to the record's parent list (a real link, not history
  // back). Both must be set to show it.
  backHref?: string;
  backLabel?: string;
}) {
  return (
    <div className="bg-gradient-to-br from-brand-navy via-brand-navy to-brand-navyDeep px-8 pb-20 pt-12 text-brand-cream">
      {backHref && backLabel && (
        <Link
          href={backHref}
          className="mb-4 inline-flex items-center gap-1 text-sm text-brand-cream/70 transition-colors hover:text-brand-cream"
        >
          <span aria-hidden="true">←</span> {backLabel}
        </Link>
      )}
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <h1 className="font-serif text-4xl font-semibold leading-tight tracking-tight">{name}</h1>
          {humanLine && <p className="mt-2 text-brand-cream/85">{humanLine}</p>}
          {subLine && <p className="mt-1 text-sm text-brand-cream/55">{subLine}</p>}
        </div>
        <Link
          href={editHref}
          className="shrink-0 rounded-full border border-brand-cream/25 px-4 py-1.5 text-sm text-brand-cream/90 transition-colors hover:bg-brand-cream/10"
        >
          Edit
        </Link>
      </div>
    </div>
  );
}
