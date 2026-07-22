// Treated "out-of-focus map" backdrop for the client-facing hub — the soft,
// cream-washed map behind the content (matching Michelle's Figma). A light blur +
// a cream overlay keep it a backdrop, never competing with the white content
// cards that float over it.
//
// References /public/map-bg.jpg. Until that file is committed the image simply
// doesn't load and the cream base shows through — so this is safe to ship before
// the asset lands, and lights up the moment it does. Decorative only
// (aria-hidden, pointer-events-none).
//
// Tuning knobs live here in one place: BLUR + the cream overlay opacity.
const BLUR = "1.5px";
const OVERLAY = "bg-brand-cream/55";

export function HubBackground() {
  return (
    <div aria-hidden className="pointer-events-none absolute inset-0 bg-brand-cream">
      <div
        className="absolute inset-0"
        style={{
          backgroundImage: "url('/map-bg.jpg')",
          backgroundSize: "cover",
          backgroundPosition: "center",
          filter: `blur(${BLUR})`,
          transform: "scale(1.04)",
        }}
      />
      <div className={`absolute inset-0 ${OVERLAY}`} />
    </div>
  );
}

// Convenience wrapper for hub surfaces that live inside the staff app shell (which
// paints its own cream): a positioned container so the backdrop scrolls with the
// page, plus the standard max-width content column above it.
export function HubShell({ children }: { children: React.ReactNode }) {
  return (
    <div className="relative min-h-full">
      <HubBackground />
      <div className="relative mx-auto max-w-5xl px-6 py-8">{children}</div>
    </div>
  );
}
