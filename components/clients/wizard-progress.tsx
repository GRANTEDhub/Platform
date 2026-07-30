// Intake progress, shared by every step.
//
// The intake spans a route boundary: steps 1-5 are the pre-create form, and steps 6
// (data pull) and 7 (engagement) run against the created record on their own pages.
// That boundary is an implementation detail -- to the person filling it in it is one
// seven-step flow, so the same bar renders on all of them. Without this, the bar
// vanished the moment the record was created, which read as "I've been thrown out of
// the form".
export function WizardProgress({
  step,
  total,
  title,
  kindLabel,
}: {
  step: number;
  total: number;
  title: string;
  kindLabel: string;
}) {
  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between text-xs text-muted-foreground">
        <span className="font-medium uppercase tracking-wide">
          Step {step} of {total} · {title}
        </span>
        <span>New {kindLabel}</span>
      </div>
      <div className="flex gap-1.5">
        {Array.from({ length: total }, (_, i) => (
          <span
            key={i}
            className={`h-1 flex-1 rounded-full transition-colors ${
              i < step ? "bg-brand-orange" : "bg-brand-navy/10"
            }`}
          />
        ))}
      </div>
    </div>
  );
}
