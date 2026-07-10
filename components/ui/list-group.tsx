import * as React from "react";
import { cn } from "@/lib/utils";
import { Card } from "@/components/ui/card";

// ListGroup — the card-container-with-hairline-divided-rows pattern (visual
// refresh, epic #92; deferred from #94, shaped first against the Matches queue).
// A floating soft Card holding an optional header and a stack of hairline-divided
// rows -- NO per-row shadow, so the group reads as one editorial container instead
// of shadow-on-shadow. Reused by Prospects / Leads when they restyle.
//
//   <ListGroup>
//     <ListGroupHeader title=… subtitle=… right={…} />
//     <ListGroupRow>…cells…</ListGroupRow>
//     …
//   </ListGroup>

export function ListGroup({ className, children, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <Card elevation="soft" className={cn("overflow-hidden", className)} {...props}>
      {children}
    </Card>
  );
}

// Header row: title/subtitle cluster on the left, an optional right-hand slot
// (e.g. a "N new" count pill), with a bottom hairline separating it from the rows.
export function ListGroupHeader({
  title,
  subtitle,
  right,
  className,
}: {
  title: React.ReactNode;
  subtitle?: React.ReactNode;
  right?: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("flex items-center justify-between gap-4 border-b border-brand-navy/10 px-6 py-4", className)}>
      <div className="min-w-0">
        <span className="font-serif text-lg font-semibold text-brand-navy">{title}</span>
        {subtitle && (
          <span className="ml-2.5 text-xs font-medium capitalize text-muted-foreground">{subtitle}</span>
        )}
      </div>
      {right}
    </div>
  );
}

// A single row: hairline top-divider (except the first), warm hover tint. The
// caller lays out its own cells inside (Matches uses a title block + score /
// status / date columns).
export function ListGroupRow({ className, children, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn(
        "border-t border-brand-navy/10 px-6 py-3.5 transition-colors first:border-t-0 hover:bg-brand-cream/50",
        className,
      )}
      {...props}
    >
      {children}
    </div>
  );
}
