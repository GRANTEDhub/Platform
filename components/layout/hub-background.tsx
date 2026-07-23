// Backdrops for the client-facing hub surfaces, selected via HubShell's `variant`:
//
//   texture — warm-cream + faint contour lines (PageBackdrop). The de-staled body
//             treatment for card-dense pages (dashboard, report list, swipe).
//   map     — the photo itself, FIXED to the viewport so it frames at a natural
//             zoom (landscape crop of a wide image) and stays visible top-to-bottom
//             as the page scrolls. Used on the grant detail. Uses a pre-softened
//             asset (map-bg-soft.jpg) because background-attachment:fixed can't take
//             a live CSS filter.
import { PageBackdrop } from "./page-backdrop";

function MapBackdrop() {
  return (
    <div aria-hidden className="pointer-events-none absolute inset-0 bg-brand-cream">
      <div
        className="absolute inset-0"
        style={{
          backgroundImage: "url('/map-bg-soft.jpg')",
          backgroundSize: "cover",
          backgroundPosition: "center",
          backgroundAttachment: "fixed",
        }}
      />
      <div className="absolute inset-0 bg-brand-cream/40" />
    </div>
  );
}

const MAX_W: Record<"5xl" | "6xl" | "7xl", string> = {
  "5xl": "max-w-5xl",
  "6xl": "max-w-6xl",
  "7xl": "max-w-7xl",
};

// Positioned container so the backdrop sits behind the page, plus a max-width
// content column above it. `width` widens the column (the report list uses "7xl").
export function HubShell({
  children,
  variant = "texture",
  width = "5xl",
}: {
  children: React.ReactNode;
  variant?: "texture" | "map";
  width?: "5xl" | "6xl" | "7xl";
}) {
  return (
    <div className="relative min-h-full">
      {variant === "map" ? <MapBackdrop /> : <PageBackdrop />}
      <div className={`relative mx-auto ${MAX_W[width]} px-6 py-8`}>{children}</div>
    </div>
  );
}
