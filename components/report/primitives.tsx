import { Check } from "lucide-react";
import type { FitBand } from "@/lib/report/shape";

// Shared, presentation-only Grant Report primitives. No "use client" and no
// hooks, so they render on the server (detail) AND inside the client list without
// duplication — the two surfaces stay pixel-identical.

const RING_TONE: Record<FitBand["tone"], { border: string; word: string }> = {
  strong: { border: "border-brand-orange/70", word: "text-brand-orange" },
  good: { border: "border-brand-navy/25", word: "text-muted-foreground" },
  fair: { border: "border-brand-navy/12", word: "text-muted-foreground" },
};

// The circular fit badge: score over 3 with the band word beneath. `lg` is the
// detail hero; the default is the list row.
export function ScoreRing({
  fitScore,
  band,
  size = "md",
}: {
  fitScore: number;
  band: FitBand;
  size?: "md" | "lg";
}) {
  const tone = RING_TONE[band.tone];
  const box = size === "lg" ? "h-[92px] w-[92px]" : "h-[68px] w-[68px]";
  const num = size === "lg" ? "text-[30px]" : "text-[22px]";
  const word = size === "lg" ? "text-[10px]" : "text-[9px]";
  return (
    <div className={`flex ${box} shrink-0 flex-col items-center justify-center rounded-full border-2 ${tone.border}`}>
      <span className={`${num} font-semibold leading-none text-brand-navy`}>
        {fitScore}
        <span className="text-xs font-normal text-muted-foreground">/3</span>
      </span>
      <span className={`mt-0.5 ${word} font-semibold uppercase tracking-wide ${tone.word}`}>{band.label}</span>
    </div>
  );
}

// ✓ / ~ / – mark for a factor rating.
export function FactorMark({ mark, className }: { mark: "check" | "approx" | "dash"; className: string }) {
  if (mark === "check") return <Check className={`h-3.5 w-3.5 ${className}`} strokeWidth={3} aria-hidden />;
  return (
    <span className={`text-[13px] font-bold leading-none ${className}`} aria-hidden>
      {mark === "approx" ? "~" : "–"}
    </span>
  );
}

// Small navy chip used for role / focus-area tags on a row.
export function Tag({ children }: { children: React.ReactNode }) {
  return (
    <span className="rounded-full bg-brand-navy/[0.06] px-2.5 py-0.5 text-[11px] font-medium text-brand-navy">
      {children}
    </span>
  );
}
