// IntellEngine's own wordmark -- a distinct sub-brand (its own color, per the
// source design), used only within IntellEngine surfaces. The icon is
// GRANTED's own "G" mark, rotated -- per the source Figma, IntellEngine's
// mark is the GRANTED mark itself, tilted, not a separate icon. No trademark
// symbol: legal flagged this specifically (Intel-name collision risk), it
// must never appear on this wordmark.
export function IntellEngineLogo({ size = "md" }: { size?: "sm" | "md" | "lg" }) {
  const px = { sm: 18, md: 26, lg: 34 }[size];
  const text = { sm: "text-lg", md: "text-2xl", lg: "text-4xl" }[size];
  return (
    <div className="inline-flex items-center gap-2">
      <img
        src="/granted-mark-dark.svg"
        alt=""
        style={{ width: px, height: px }}
        className="rotate-90"
      />
      <span className={`font-serif ${text} font-semibold text-brand-intellEngine`}>
        intell<span className="font-normal italic text-brand-intellEngineLight">Engine</span>
      </span>
    </div>
  );
}
