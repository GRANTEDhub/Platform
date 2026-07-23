import * as React from "react";
import { cn } from "@/lib/utils";

// Floating card surface (visual refresh, epic #92). Default `soft` is the warm
// floating card on cream; `flat` is a bordered nested surface (no shadow); `lift`
// is the strongest elevation. Existing consumers get `soft` by default.
const ELEVATION = {
  soft: "rounded-2xl bg-white shadow-soft",
  flat: "rounded-2xl border border-brand-navy/10 bg-white",
  lift: "rounded-2xl bg-white shadow-lift",
  // A defined drop (not a diffuse halo) so cards sit clearly on a busy backdrop
  // (the grant detail's photo backdrop) instead of blending into it.
  card: "rounded-2xl border border-brand-navy/[0.05] bg-white shadow-card",
} as const;

export function Card({
  className,
  elevation = "soft",
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
