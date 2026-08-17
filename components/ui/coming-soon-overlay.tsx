// The one "COMING SOON" watermark laid diagonally across a gated tile, shared by every
// presentation-gated surface (the dashboard IntellEngine tile, the Grant Report pursue-chooser
// option) so the treatment cannot drift between them.
//
// TEXT, NOT COLOUR. The gated state is carried by the literal word "Coming soon", not by a hue, so
// it reads for a colorblind viewer. This element is decorative (aria-hidden): the caller renders its
// own visible, screen-reader-available copy and is what actually makes the tile inert (no links /
// pointer-events-none) -- this is only the label on top.
//
// `tone` picks the contrast for the ground it sits on: onDark for the navy IntellEngine panel,
// onLight for a white card.
export function ComingSoonOverlay({ tone = "onLight" }: { tone?: "onLight" | "onDark" }) {
  const plate =
    tone === "onDark" ? "border-white/70 text-white" : "border-brand-navy/60 text-brand-navy";
  return (
    <div
      aria-hidden="true"
      className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center overflow-hidden"
    >
      <span
        className={`-rotate-[14deg] select-none whitespace-nowrap rounded-sm border-2 px-4 py-1.5 text-[13px] font-extrabold uppercase tracking-[0.28em] ${plate}`}
      >
        Coming soon
      </span>
    </div>
  );
}
