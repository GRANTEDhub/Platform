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
}: {
  name: string;
  humanLine: string | null;
  subLine: string | null;
  editHref: string;
}) {
  return (
    <div className="bg-gradient-to-br from-brand-navy via-brand-navy to-[#081627] px-8 pb-20 pt-12 text-brand-cream">
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
