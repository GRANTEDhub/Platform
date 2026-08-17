"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

// The desktop hover/focus pop-out for a factor's rationale, shared by the grant-review console and
// the match-score card so the bespoke overlay geometry (the 262px cap) and the reveal mechanism
// cannot drift between them -- they already had (z-10 vs z-20, text-xs vs text-[11px]) before this
// was single-sourced.
//
// RENDERED IN A PORTAL to document.body, positioned with JS. Both surfaces sit inside a fixed-height
// `overflow-hidden` / `overflow-y-auto` card (the console's RationaleCard, match-score's cards), and
// an in-flow `absolute` pop-out is CLIPPED by that ancestor -- it slid under the card's top edge and
// read as "the popover renders under the Match rationale box." No z-index defeats `overflow: hidden`;
// only lifting the bubble out of every clipping ancestor does. The reveal is therefore NO LONGER CSS
// group-hover: it is JS mouseenter/leave + focusin/out listeners on the trigger row, gating a
// createPortal render on document.body at FIXED coords from the row's getBoundingClientRect(),
// re-measured while open as the page (or an inner scroll container) scrolls. It flips below the row
// when there isn't room above (a row scrolled near the viewport top on the scrollable review page).
//
// The PARENT row still owns the trigger and MUST:
//   - be FOCUSABLE (tabIndex={0} / a real button) -- this component wires the listeners onto that
//     parent row, so a focusable row is what makes the reveal keyboard-reachable (the affordance the
//     old <details>/<summary> gave for free; this surface is shared with the client portal), and
//   - carry `title={rationale}` -- the no-JS / assistive-tech fallback that reveals on hover before
//     this component's JS has mounted (and if the styled bubble is ever positioned off-screen).
// It NO LONGER needs `group` or `relative`: nothing reveals via a `group-*` selector and the bubble
// is not an absolute child of the row.
export function RationaleHoverPopover({ rationale }: { rationale: string }) {
  // A zero-box marker whose parentElement IS the trigger row (the pop-out is the row's last child in
  // both callers). `display:contents` keeps it out of layout while still resolving to the row.
  const anchorRef = useRef<HTMLSpanElement>(null);
  const bubbleRef = useRef<HTMLSpanElement>(null);
  // Hover and focus are TWO INDEPENDENT inputs OR'd together -- open = hovering || focused -- so a
  // mouseleave can't close a bubble the row still holds by keyboard focus, and vice versa. Collapsing
  // them into one boolean (last-event-wins) closed the pop-out on a row that was hovered THEN focused
  // (a click focuses a tabIndex=0 row) the moment the mouse left. This restores the old CSS
  // `group-hover:block group-focus-within:block` OR semantics.
  const [hovering, setHovering] = useState(false);
  const [focused, setFocused] = useState(false);
  const open = hovering || focused;
  const [pos, setPos] = useState<{ left: number; top: number; below: boolean } | null>(null);

  const place = useCallback(() => {
    const row = anchorRef.current?.parentElement;
    if (!row) return;
    const r = row.getBoundingClientRect();
    // Prefer above the row (its top-right corner); flip BELOW when there isn't room above -- a row
    // scrolled to within a tooltip-height of the viewport top on the scrollable review/report page.
    // Measure the bubble's real height once it's mounted; fall back to a conservative estimate for
    // the first placement (multi-line rationales are taller, so err toward flipping).
    const h = bubbleRef.current?.offsetHeight ?? 96;
    const below = r.top < h + 8;
    setPos({ left: r.right, top: below ? r.bottom : r.top, below });
  }, []);

  useEffect(() => {
    const row = anchorRef.current?.parentElement;
    if (!row) return;
    const onEnter = () => setHovering(true);
    const onLeave = () => setHovering(false);
    const onFocus = () => setFocused(true);
    const onBlur = () => setFocused(false);
    row.addEventListener("mouseenter", onEnter);
    row.addEventListener("mouseleave", onLeave);
    row.addEventListener("focusin", onFocus);
    row.addEventListener("focusout", onBlur);
    return () => {
      row.removeEventListener("mouseenter", onEnter);
      row.removeEventListener("mouseleave", onLeave);
      row.removeEventListener("focusin", onFocus);
      row.removeEventListener("focusout", onBlur);
    };
  }, []);

  // Position when it opens (the bubble is mounted this commit, so place() can measure it) and keep it
  // glued to the row while open as the page or an inner scroll container moves. Capture-phase scroll
  // so scrolling the console's own overflow-y-auto card is caught too. Clear pos on close.
  useEffect(() => {
    if (!open) {
      setPos(null);
      return;
    }
    place();
    const onMove = () => place();
    window.addEventListener("scroll", onMove, true);
    window.addEventListener("resize", onMove);
    return () => {
      window.removeEventListener("scroll", onMove, true);
      window.removeEventListener("resize", onMove);
    };
  }, [open, place]);

  return (
    <span ref={anchorRef} className="contents">
      {open &&
        typeof document !== "undefined" &&
        createPortal(
          <span
            ref={bubbleRef}
            role="tooltip"
            // pointer-events-none: the tooltip never eats the hover it depends on. fixed + the
            // translate pair place it 6px above (or below, when flipped) the row's right edge. z is
            // high because it now shares the document.body stacking context with the whole page.
            // Hidden until positioned so the first paint never flashes at a stale spot.
            className={`pointer-events-none fixed z-[80] max-w-[262px] -translate-x-full rounded-lg bg-brand-navy px-3 py-2 text-[11px] leading-relaxed text-white shadow-lg ${
              pos?.below ? "translate-y-[6px]" : "-translate-y-[calc(100%+6px)]"
            }`}
            style={{ left: pos?.left ?? -9999, top: pos?.top ?? -9999, visibility: pos ? "visible" : "hidden" }}
          >
            {rationale}
            {/* Arrow points toward the row: down from the bubble's bottom when above, up from its top
                when flipped below. */}
            <span
              className={
                pos?.below
                  ? "absolute bottom-full right-6 h-0 w-0 border-x-[6px] border-b-[6px] border-x-transparent border-b-brand-navy"
                  : "absolute top-full right-6 h-0 w-0 border-x-[6px] border-t-[6px] border-x-transparent border-t-brand-navy"
              }
            />
          </span>,
          document.body,
        )}
    </span>
  );
}
