"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

// The desktop hover/focus pop-out for a factor's rationale, shared by the grant-review console and
// the match-score card so the bespoke overlay geometry (the 262px cap) and the reveal mechanism
// cannot drift between them -- they already had (z-10 vs z-20, text-xs vs text-[11px]) before this
// was single-sourced.
//
// RENDERED IN A PORTAL to document.body. Both surfaces sit inside a fixed-height
// `overflow-hidden` / `overflow-y-auto` card (the console's RationaleCard, match-score's cards), and
// an in-flow `absolute` pop-out is CLIPPED by that ancestor -- it slid under the card's top edge and
// read as "the popover renders under the Match rationale box." No z-index defeats `overflow: hidden`;
// only lifting the bubble out of every clipping ancestor does. The portal paints it on document.body
// at the top of the stacking context, positioned with FIXED coords taken from the trigger row's rect
// and re-measured while open as the page (or an inner scroll container) scrolls.
//
// The PARENT row still owns the trigger and MUST:
//   - be `group relative` (kept for the callers' existing hover styling) and, critically, be
//     FOCUSABLE (tabIndex={0} / a real button) -- this component wires hover AND focus listeners onto
//     that parent row, so a focusable row is what makes the reveal keyboard-reachable (the affordance
//     the old <details>/<summary> gave for free; this surface is shared with the client portal), and
//   - carry `title={rationale}` -- the clip-proof, no-JS, assistive-tech fallback that always reveals
//     on hover even before this component's JS has mounted.
export function RationaleHoverPopover({ rationale }: { rationale: string }) {
  // A zero-box marker whose parentElement IS the trigger row (the pop-out is the row's last child in
  // both callers). `display:contents` keeps it out of layout while still resolving to the row.
  const anchorRef = useRef<HTMLSpanElement>(null);
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);

  const place = useCallback(() => {
    const row = anchorRef.current?.parentElement;
    if (!row) return;
    const r = row.getBoundingClientRect();
    // Anchor point: the row's top-right corner. The bubble is then translated up by its own height
    // (+6px gap) and left by its own width, reproducing the old `bottom-full right-0 mb-1.5`.
    setPos({ left: r.right, top: r.top });
  }, []);

  useEffect(() => {
    const row = anchorRef.current?.parentElement;
    if (!row) return;
    const show = () => {
      place();
      setOpen(true);
    };
    const hide = () => setOpen(false);
    // mouseenter/leave (desktop hover) + focusin/out (keyboard, and touch since the row is focusable)
    row.addEventListener("mouseenter", show);
    row.addEventListener("mouseleave", hide);
    row.addEventListener("focusin", show);
    row.addEventListener("focusout", hide);
    return () => {
      row.removeEventListener("mouseenter", show);
      row.removeEventListener("mouseleave", hide);
      row.removeEventListener("focusin", show);
      row.removeEventListener("focusout", hide);
    };
  }, [place]);

  // While open, keep the bubble glued to the row as the page or an inner scroll container moves.
  // Capture-phase scroll so scrolling the console's own overflow-y-auto card is caught too.
  useEffect(() => {
    if (!open) return;
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
        pos &&
        typeof document !== "undefined" &&
        createPortal(
          <span
            role="tooltip"
            // pointer-events-none: the tooltip never eats the hover it depends on. fixed + the
            // translate pair place its bottom-right 6px above the row's top-right. z is high because
            // it now shares the document.body stacking context with everything else on the page.
            className="pointer-events-none fixed z-[80] max-w-[262px] -translate-x-full -translate-y-[calc(100%+6px)] rounded-lg bg-brand-navy px-3 py-2 text-[11px] leading-relaxed text-white shadow-lg"
            style={{ left: pos.left, top: pos.top }}
          >
            {rationale}
            <span className="absolute right-6 top-full h-0 w-0 border-x-[6px] border-t-[6px] border-x-transparent border-t-brand-navy" />
          </span>,
          document.body,
        )}
    </span>
  );
}
