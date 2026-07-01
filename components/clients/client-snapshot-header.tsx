import Link from "next/link";

// Branded snapshot band for the client dashboard: navy field, cream serif name,
// burnt-orange stat chips. This is the first client-facing-shaped surface, so it
// sets the tone the eventual client view inherits.
export type SnapshotChip = { label: string; value: string };

export function ClientSnapshotHeader({
  name,
  subtitle,
  chips,
  editHref,
}: {
  name: string;
  subtitle: string | null;
  chips: SnapshotChip[];
  editHref: string;
}) {
  return (
    <div className="bg-brand-navy px-8 py-8 text-brand-cream">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <h1 className="font-serif text-3xl font-semibold tracking-tight">{name}</h1>
          {subtitle && <p className="mt-1 text-sm text-brand-cream/70">{subtitle}</p>}
        </div>
        <Link href={editHref} className="shrink-0 text-sm text-brand-cream/80 underline hover:text-brand-cream">
          Edit
        </Link>
      </div>
      {chips.length > 0 && (
        <div className="mt-5 flex flex-wrap gap-2">
          {chips.map((c, i) => (
            <span
              key={i}
              className="rounded-full bg-brand-orange px-3 py-1 text-xs text-brand-cream"
            >
              <span className="font-semibold">{c.value}</span> {c.label}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}
