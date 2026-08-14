// The desktop hover/focus pop-out for a factor's rationale, shared by the grant-review console and
// the match-score card so the bespoke overlay geometry (the 262px cap, the arrow's border math) and
// the reveal mechanism cannot drift between them -- they already had (z-10 vs z-20, text-xs vs
// text-[11px]) before this was single-sourced.
//
// The PARENT row owns the trigger and MUST:
//   - be `group relative` (this pop-out is `absolute` and revealed by the group's hover/focus),
//   - carry `title={rationale}` -- the clip-proof fallback for when a fixed-height ancestor's overflow
//     clips the styled pop-out (the tradeoff match-score.tsx documents), and
//   - be focusable (tabIndex={0} / a real button) so `group-focus-within` makes the reveal reachable by
//     keyboard -- the affordance the old <details>/<summary> gave for free, restored here for both
//     surfaces (this component is shared with the client portal via grant-review-console).
export function RationaleHoverPopover({ rationale }: { rationale: string }) {
  return (
    <div className="pointer-events-none absolute bottom-full right-0 z-20 mb-1.5 hidden max-w-[262px] rounded-lg bg-brand-navy px-3 py-2 text-[11px] leading-relaxed text-white shadow-lg group-hover:block group-focus-within:block">
      {rationale}
      <span className="absolute right-6 top-full h-0 w-0 border-x-[6px] border-t-[6px] border-x-transparent border-t-brand-navy" />
    </div>
  );
}
