import type { FactorScore, FactorScores, FactorRating } from "@/types/database";
import { RationaleHoverPopover } from "@/components/report/rationale-hover";

// The platform's honest match-scoring graphic, extracted so BOTH the staff review
// (/review/[id]) and the shared Grant Report detail render the exact same chart.
// Ordinal, never a percentage: the ring fills fit_score/3 and each factor is a
// 3-segment bar (fill carries meaning, not hue — the user is colorblind). This chart is
// itself a server component; its ONLY client leaf is RationaleHoverPopover, the
// portal-rendered per-row rationale pop-out.

// Segment count per rating. "insufficient_data" is a dashed hollow track —
// deliberately NOT a 1-segment bar, so it never reads as "Weak".
const FACTOR_SEGMENTS: Record<Exclude<FactorRating, "insufficient_data">, number> = {
  strong: 3,
  moderate: 2,
  weak: 1,
};
const FACTOR_WORD: Record<FactorRating, string> = {
  strong: "Strong",
  moderate: "Moderate",
  weak: "Weak",
  insufficient_data: "insufficient data",
};

const FACTOR_ROWS: { key: keyof FactorScores; label: string }[] = [
  { key: "seat_role", label: "Seat / role fit" },
  { key: "eligibility", label: "Eligibility" },
  { key: "geographic", label: "Geographic fit" },
  { key: "program_history", label: "Program history" },
  { key: "cost_share", label: "Match / cost-share" },
  { key: "mission", label: "Mission alignment" },
];

const DEFAULT_NOTE =
  "Bar fill = rating (3 / 2 / 1 segments). Dashed = no data yet — distinct from a one-segment “Weak.” Hover a row for the rationale.";

// One factor row: name + word label + 3-segment bar (or a dashed hollow track for
// insufficient data). The one-line rationale rides in a desktop hover/focus pop-out
// (RationaleHoverPopover, portal-rendered).
function FactorRow({ label, score }: { label: string; score: FactorScore }) {
  const insufficient = score.rating === "insufficient_data";
  const filled = score.rating === "insufficient_data" ? 0 : FACTOR_SEGMENTS[score.rating];
  return (
    <li
      // NATIVE title AS WELL AS the styled pop-out. The styled RationaleHoverPopover now
      // renders in a PORTAL (document.body), so an overflow:hidden ancestor no longer
      // clips it -- the reason it used to vanish once the redesign wrapped these cards in
      // fixed-height overflow boxes. The native title stays as the no-JS / assistive-tech
      // fallback that always reveals on hover, even before the pop-out's JS has mounted.
      title={score.rationale ?? undefined}
      // Focusable when it has a rationale, so the pop-out (revealed by focusin on this row) is
      // reachable by keyboard, not hover-only. Rows with no rationale stay out of the tab order.
      tabIndex={score.rationale ? 0 : undefined}
      className={`flex items-center justify-between gap-3 rounded-md px-1.5 py-1.5 outline-none transition-colors hover:bg-brand-cream/70 focus-visible:ring-1 focus-visible:ring-brand-navy/40 ${
        insufficient ? "opacity-60" : ""
      }`}
    >
      <span className="text-sm font-medium text-brand-navy">{label}</span>
      <div className="flex items-center gap-3">
        <span
          className={`min-w-[92px] text-right text-[11px] text-muted-foreground ${insufficient ? "italic" : ""}`}
        >
          {FACTOR_WORD[score.rating]}
        </span>
        {insufficient ? (
          <span className="h-2.5 w-[126px] rounded-full border border-dashed border-brand-navy/30" aria-hidden />
        ) : (
          <span className="flex gap-1.5" aria-hidden>
            {[1, 2, 3].map((n) => (
              <span
                key={n}
                className={`h-2.5 w-[38px] rounded-full ${n <= filled ? "bg-brand-navy" : "bg-brand-navy/[0.12]"}`}
              />
            ))}
          </span>
        )}
      </div>
      {score.rationale && <RationaleHoverPopover rationale={score.rationale} />}
    </li>
  );
}

export function FactorBreakdown({
  scores,
  heading = "Factor breakdown",
  note = DEFAULT_NOTE,
}: {
  scores: FactorScores | null;
  heading?: string;
  note?: string | null;
}) {
  return (
    <div>
      {heading && <p className="text-[11px] font-semibold uppercase tracking-[0.1em] text-brand-orange">{heading}</p>}
      {!scores ? (
        <p className={`${heading ? "mt-2 " : ""}text-sm text-muted-foreground`}>
          Not yet scored for factors — re-match this grant to generate the per-factor breakdown.
        </p>
      ) : (
        <>
          <ul className={`${heading ? "mt-2 " : ""}space-y-0.5`}>
            {FACTOR_ROWS.map(({ key, label }) => {
              const f = scores[key];
              if (!f) return null;
              return <FactorRow key={key} label={label} score={f} />;
            })}
          </ul>
          {note && <p className="mt-3 px-1.5 text-[11px] leading-relaxed text-muted-foreground">{note}</p>}
        </>
      )}
    </div>
  );
}

// Honest "N of 3" radial ring — NOT a 0-100 gauge. The arc fills fit_score/3 of the
// circle. Driven by fit_score (always present), so it renders even when
// factor_scores is null. The center is the literal ordinal, never a percentage.
export function ScoreArcRing({ fitScore, size = 168 }: { fitScore: number; size?: number }) {
  const stroke = Math.round(size * 0.077);
  const r = (size - stroke) / 2;
  const circ = 2 * Math.PI * r;
  const frac = Math.max(0, Math.min(1, (Number.isFinite(fitScore) ? fitScore : 0) / 3));
  const filled = circ * frac;
  const numClass = size >= 140 ? "text-5xl" : "text-3xl";
  return (
    <div className="relative flex-none" style={{ width: size, height: size }}>
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} className="-rotate-90" aria-hidden>
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" strokeWidth={stroke} className="stroke-brand-navy/10" />
        {filled > 0 && (
          <circle
            cx={size / 2}
            cy={size / 2}
            r={r}
            fill="none"
            strokeWidth={stroke}
            strokeLinecap="round"
            strokeDasharray={`${filled} ${circ - filled}`}
            className="stroke-brand-orange"
          />
        )}
      </svg>
      <div className="absolute inset-0 flex flex-col items-center justify-center">
        <span className={`font-serif ${numClass} font-semibold leading-none text-brand-navy`}>{fitScore}</span>
        <span className="mt-1.5 text-xs font-medium text-muted-foreground">of 3</span>
      </div>
    </div>
  );
}
