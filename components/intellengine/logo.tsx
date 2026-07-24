// IntellEngine's own wordmark. GRANTED's own colors, not a separate palette:
// "intell" in brand navy, "Engine" in brand orange. The icon is GRANTED's own
// "G" mark, rotated, standing in for the "I" itself (not sitting beside the
// word as a separate icon) -- granted-mark-light.svg (navy fill, for light
// backgrounds; -dark.svg is the white variant meant for dark surfaces like
// the sidebar, wrong here). No trademark symbol: legal flagged this
// specifically (Intel-name collision risk), it must never appear here.
export function IntellEngineLogo({ size = "md" }: { size?: "sm" | "md" | "lg" }) {
  const px = { sm: 20, md: 28, lg: 38 }[size];
  const text = { sm: "text-lg", md: "text-2xl", lg: "text-4xl" }[size];
  return (
    <div className="inline-flex items-baseline">
      <img
        src="/granted-mark-light.svg"
        alt="I"
        style={{ width: px, height: px }}
        className="relative top-[0.14em] -mr-0.5 rotate-90"
      />
      <span className={`font-serif ${text} font-semibold text-brand-navy`}>
        ntell<span className="font-normal italic text-brand-orange">Engine</span>
      </span>
    </div>
  );
}
