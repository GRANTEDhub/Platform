"use client";

// Clickable section nav for the EDIT profile.
//
// Create and edit are the same form but not the same job, so they navigate
// differently:
//
//   CREATE -> a guided wizard (Back / Next). The steps have a real order: step 2 must
//             not mount before the website craft has landed, and nothing is saved
//             until the last page. Jumping around would break both.
//   EDIT   -> this. You arrive to change ONE thing, so the progress bar IS the
//             navigation rather than a read-out of how far you have got. Every section
//             is one click away and every field stays in the DOM regardless of which
//             pane is showing, so saving from any section writes the whole profile.
//
// Two clickable layers on purpose: the labels (what you actually aim at) and the bar
// segments beneath them (the familiar target, kept from the create wizard so the two
// flows still look like the same form).
export function StepNav({
  steps,
  active,
  onSelect,
  label,
}: {
  steps: { key: string; short: string }[];
  active: number;
  onSelect: (index: number) => void;
  // Right-hand caption, e.g. "Editing client".
  label?: string;
}) {
  return (
    <nav aria-label="Profile sections" className="space-y-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap gap-1.5">
          {steps.map((s, i) => (
            <button
              key={s.key}
              type="button"
              onClick={() => onSelect(i)}
              aria-current={i === active ? "step" : undefined}
              className={`rounded-full px-3 py-1.5 text-xs font-medium transition-colors ${
                i === active
                  ? "bg-brand-navy text-white"
                  : "bg-brand-navy/[0.06] text-muted-foreground hover:bg-brand-navy/[0.12] hover:text-brand-navy"
              }`}
            >
              {s.short}
            </button>
          ))}
        </div>
        {label && <span className="text-xs text-muted-foreground">{label}</span>}
      </div>
      <div className="flex gap-1.5">
        {steps.map((s, i) => (
          <button
            key={s.key}
            type="button"
            onClick={() => onSelect(i)}
            // The labels above carry the accessible name; these are the same targets
            // again, so hide them from the a11y tree rather than duplicating every
            // section in the tab order.
            tabIndex={-1}
            aria-hidden="true"
            className={`h-1 flex-1 rounded-full transition-colors ${
              i === active ? "bg-brand-orange" : "bg-brand-navy/10 hover:bg-brand-navy/25"
            }`}
          />
        ))}
      </div>
    </nav>
  );
}
