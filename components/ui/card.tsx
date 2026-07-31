import * as React from "react";
import { cn } from "@/lib/utils";

// Card surface. THREE options, and only one of them is an elevation step up.
//
// This component used to offer four (`soft`, `grounded`, `lift`, `flat`), which is
// where most of the "sibling cards look like they came from different designs"
// problem originated: two of the four were rest-state elevations differing only in
// how heavy the drop was, chosen per-page rather than per-role.
//
//   card    — every card. The default.
//   flat    — a nested surface INSIDE a card: border, no shadow. Not an elevation
//             step; a card on a card does not float higher, it just delineates.
//   overlay — menus, popovers, the command palette. Over the page, not on it.
const ELEVATION = {
  card: "rounded-2xl bg-white shadow-card",
  flat: "rounded-2xl border border-hairline-strong bg-white",
  overlay: "rounded-2xl bg-white shadow-overlay",
} as const;

export function Card({
  className,
  elevation = "card",
  ...props
}: React.HTMLAttributes<HTMLDivElement> & { elevation?: keyof typeof ELEVATION }) {
  return <div className={cn(ELEVATION[elevation], "text-card-foreground", className)} {...props} />;
}

export function CardHeader({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("flex flex-col space-y-1.5 p-6", className)} {...props} />;
}

export function CardTitle({ className, ...props }: React.HTMLAttributes<HTMLHeadingElement>) {
  return (
    <h3 className={cn("font-semibold leading-none tracking-tight", className)} {...props} />
  );
}

export function CardDescription({ className, ...props }: React.HTMLAttributes<HTMLParagraphElement>) {
  return <p className={cn("text-sm text-muted-foreground", className)} {...props} />;
}

export function CardContent({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("p-6 pt-0", className)} {...props} />;
}
