import Link from "next/link";

export function PageHeader({
  title,
  description,
  action,
  backHref,
  backLabel,
}: {
  title: string;
  description?: string;
  action?: React.ReactNode;
  // Contextual "up" navigation to the logical PARENT route -- a real link, not
  // router.back(), so it's predictable regardless of how the user arrived. Rendered
  // above the title on detail pages; both must be set to show it.
  backHref?: string;
  backLabel?: string;
}) {
  return (
    <div className="border-b bg-card px-8 py-6">
      {backHref && backLabel && (
        <Link
          href={backHref}
          className="mb-2 inline-flex items-center gap-1 text-sm font-medium text-muted-foreground transition-colors hover:text-foreground"
        >
          <span aria-hidden="true">←</span> {backLabel}
        </Link>
      )}
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
          {description && (
            <p className="mt-1 text-sm text-muted-foreground">{description}</p>
          )}
        </div>
        {action}
      </div>
    </div>
  );
}
