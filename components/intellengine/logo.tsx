import { Sparkles } from "lucide-react";

// IntellEngine's own wordmark -- a distinct sub-brand (its own icon/color, per
// the source design), used only within IntellEngine surfaces. Approximated
// with a Lucide icon rather than the original mark since no asset file exists
// in this repo.
export function IntellEngineLogo({ size = "md" }: { size?: "sm" | "md" | "lg" }) {
  const px = { sm: 18, md: 26, lg: 34 }[size];
  const text = { sm: "text-lg", md: "text-2xl", lg: "text-4xl" }[size];
  return (
    <div className="inline-flex items-center gap-2">
      <Sparkles style={{ width: px, height: px }} className="text-brand-intellEngine" strokeWidth={2.25} />
      <span className={`font-serif ${text} font-semibold text-brand-intellEngine`}>
        intell<span className="font-normal italic text-brand-intellEngineLight">Engine</span>
        <sup className="ml-0.5 text-[0.5em] font-normal not-italic">™</sup>
      </span>
    </div>
  );
}
