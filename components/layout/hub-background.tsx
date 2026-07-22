// Treated map backdrop for the client-facing hub — the soft map behind the
// content, cream-washed so the white cards float cleanly over it. Two variants:
//
//   warm  — detail + swipe surfaces: a warm, out-of-focus map (heavier blur, full
//           color). Atmospheric; used where the page is content-light.
//   crisp — the roadmap LIST: near-sharp but mostly desaturated + a heavier cream
//           wash, so the map reads as a quiet texture that doesn't compete with a
//           dense list of cards. (A touch of warmth is retained rather than full
//           grayscale, so it stays on-brand against the cream/orange UI.)
//
// References /public/map-bg.jpg; the cream base shows through if the asset is
// missing. Decorative only (aria-hidden, pointer-events-none). The crop is biased
// down (center 78%) so the photo's sun-flare rides up and out of the content zone.
type Variant = "warm" | "crisp";

const VARIANTS: Record<Variant, { filter: string; wash: string }> = {
  warm: { filter: "blur(2.5px)", wash: "bg-brand-cream/50" },
  crisp: { filter: "grayscale(0.72) contrast(0.95) blur(0.5px)", wash: "bg-brand-cream/[0.58]" },
};

export function HubBackground({ variant = "warm" }: { variant?: Variant }) {
  const v = VARIANTS[variant];
  return (
    <div aria-hidden className="pointer-events-none absolute inset-0 bg-brand-cream">
      <div
        className="absolute inset-0"
        style={{
          backgroundImage: "url('/map-bg.jpg')",
          backgroundSize: "cover",
          backgroundPosition: "center 78%",
          filter: v.filter,
          transform: "scale(1.04)",
        }}
      />
      <div className={`absolute inset-0 ${v.wash}`} />
    </div>
  );
}

// Convenience wrapper for hub surfaces inside the staff app shell (which paints
// its own cream): a positioned container so the backdrop scrolls with the page,
// plus the standard max-width content column above it.
export function HubShell({ children, variant }: { children: React.ReactNode; variant?: Variant }) {
  return (
    <div className="relative min-h-full">
      <HubBackground variant={variant} />
      <div className="relative mx-auto max-w-5xl px-6 py-8">{children}</div>
    </div>
  );
}
