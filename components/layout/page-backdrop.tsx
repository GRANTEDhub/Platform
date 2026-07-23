// Warm-cream page backdrop with a faint real topo/road map texture — de-stales
// the hub body surfaces (dashboard, grant report) without a competing photo.
// Fixed to the viewport (not the page's scrollable/padded content box) so it
// spans true edge-to-edge — behind the sidebar and out to every screen edge —
// rather than being boxed in by the app shell's own padding. Decorative only,
// negative z-index. The map photo stays an accent in hero bands / cards; this
// is the ambient texture for the page itself.
export function PageBackdrop() {
  return (
    <div aria-hidden className="pointer-events-none fixed inset-0 -z-10 bg-brand-creamWarm">
      <div
        className="absolute inset-0"
        style={{
          backgroundImage: "url('/page-texture.png')",
          backgroundSize: "cover",
          backgroundPosition: "center",
        }}
      />
      {/* warm cream wash so the texture stays faint/ambient, not a competing map */}
      <div className="absolute inset-0 bg-brand-creamWarm/45" />
    </div>
  );
}
