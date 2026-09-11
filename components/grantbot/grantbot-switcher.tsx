"use client";

import { useEffect, useState } from "react";
import dynamic from "next/dynamic";
import { usePathname, useRouter } from "next/navigation";
import { Loader2, Maximize2, Sparkles, X } from "lucide-react";
import { BRAND } from "@/lib/brand";
import { firmSwitcherVisible } from "@/lib/grantbot/switcher";

// The firm chat arrives on first open, not with the layout — the panel mounts on EVERY internal
// page, and most page views never ask GrantBot anything, so opening is what pays for the transcript
// fetch and the chat code. Mirrors the per-client GrantBotLauncher's lazy import.
const FirmGrantBotChat = dynamic(() => import("./firm-grantbot-chat").then((m) => m.FirmGrantBotChat), {
  ssr: false,
  loading: () => (
    <p className="flex flex-1 items-center gap-2 p-4 text-[13px] text-muted-foreground">
      <Loader2 className="h-3.5 w-3.5 animate-spin" /> Opening…
    </p>
  ),
});

// The GrantBot Switcher — a bubble in the bottom-right of every internal page, and the panel it
// opens. S1 hosts the FIRM bot only (admin-only, roster-wide). Mounted once in (app)/layout.tsx
// (gated by GRANTBOT_SWITCHER_ENABLED + GRANTBOT_FIRM_ENABLED), so it persists across SPA navigation.
//
// ── WHY IT STANDS DOWN ON THE CLIENT DASHBOARD ──
//
// The per-client launcher owns the corner on EXACTLY the client dashboard (/clients/<id>) — the only
// page it mounts on — and that bot needs the client's NAME, which only the record page has (the
// layout knows the path, not the name). So there the Switcher hides and the launcher shows that
// client's bot — never a double bubble. On the client's SUB-routes (/clients/<id>/roadmap, …/grantbot)
// and the /clients/new/invite forms there is NO launcher, so the firm bubble DOES show there (else
// those pages would have no bot at all — Codex #544). It also hides on the firm full page /grantbot,
// which already IS the full firm chat. firmSwitcherVisible(pathname, isAdmin) is re-evaluated on every
// navigation. S2 gives the Switcher a roster picker (and every client's identity with it), at which
// point it hosts any client bot from anywhere and subsumes the launcher.
//
// ── OPENING IS FREE, AND STAYS FREE ──
//
// Nothing is fetched until the bubble is clicked; after that the panel stays MOUNTED but invisible,
// so closing — AND navigating onto a page where the Switcher stands down — keeps the unsent draft and
// the place in the thread (an early `return null` would unmount the chat and lose the draft — Codex
// #544). The transcript is server-side, so it also survives the tab closing entirely.
export function GrantBotSwitcher({ isAdmin }: { isAdmin: boolean }) {
  const router = useRouter();
  const pathname = usePathname();
  const visible = firmSwitcherVisible(pathname, isAdmin);

  const [everOpened, setEverOpened] = useState(false);
  const [open, setOpen] = useState(false);
  const [shown, setShown] = useState(false);

  // Separate from `open` so the panel transitions in rather than appearing: it has to be in the tree
  // at its start position for one frame before the end position can animate.
  useEffect(() => {
    if (!open) {
      setShown(false);
      return;
    }
    const id = requestAnimationFrame(() => setShown(true));
    return () => cancelAnimationFrame(id);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  // Navigating onto a page where the Switcher stands down CLOSES the panel (so returning shows the
  // bubble, not a snapped-back panel) but does NOT unmount it — the panel subtree stays mounted while
  // `everOpened`, only hidden, so the unsent draft survives (Codex #544). The visible-gates below keep
  // it invisible and non-interactive while hidden.
  useEffect(() => {
    if (!visible) setOpen(false);
  }, [visible]);

  function openPanel() {
    setEverOpened(true);
    setOpen(true);
  }

  // Expand = the standalone /grantbot page. Close the corner panel first: /grantbot renders the full
  // firm chat, and an open corner panel would overlay a second chat instance on it (Codex #544).
  // (/grantbot is also excluded from firmSwitcherVisible, so the bubble does not return there; the
  // full page loads the most-recent thread — carrying the exact conversation id in is an S2 polish
  // item, the firm page reads no ?c= param yet.)
  function expand() {
    setOpen(false);
    router.push("/grantbot");
  }

  return (
    <>
      {visible && !open && (
        <button
          type="button"
          onClick={openPanel}
          className="fixed bottom-7 right-7 z-40 inline-flex h-11 items-center gap-2 rounded-pill bg-brand-navy px-4 text-[13px] font-medium text-white shadow-overlay transition-colors hover:bg-brand-navyHover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-orange/60 focus-visible:ring-offset-2"
        >
          <Sparkles className="h-4 w-4" style={{ color: BRAND.orange }} />
          Ask GrantBot
        </button>
      )}

      {everOpened && (
        <div
          role="dialog"
          aria-label="GrantBot — Firm"
          // Hidden (not unmounted) while closed OR while the Switcher stands down on this page, so the
          // draft survives; `invisible` is visibility:hidden, so it is also out of the a11y tree and
          // hit-testing and never sits over the per-client launcher.
          aria-hidden={!(open && visible)}
          className={`fixed bottom-7 right-7 z-40 flex h-[min(588px,calc(100vh-3.5rem))] w-[min(404px,calc(100vw-3.5rem))] flex-col overflow-hidden rounded-2xl bg-white shadow-floating transition-all duration-[280ms] ease-entrance ${
            open && shown && visible
              ? "visible translate-y-0 scale-100 opacity-100"
              : "invisible translate-y-4 scale-[0.98] opacity-0"
          }`}
        >
          <div className="relative flex-shrink-0 overflow-hidden bg-brand-navy px-[18px] pb-3.5 pt-4">
            {/* The accent bloom, bled off the top-right corner — BRAND.orangeGlow, so there is still
                exactly one orange in the product. */}
            <div
              aria-hidden="true"
              className="pointer-events-none absolute -right-[30px] -top-[46px] h-[140px] w-[140px] rounded-full"
              style={{ background: `radial-gradient(circle, ${BRAND.orangeGlow}, transparent 70%)` }}
            />
            <div className="relative flex items-start gap-[11px]">
              <div
                className="flex h-[30px] w-[30px] flex-shrink-0 items-center justify-center rounded-lg"
                style={{ background: BRAND.orangeTileOnInk }}
              >
                <Sparkles className="h-[15px] w-[15px]" style={{ color: BRAND.orange }} />
              </div>
              <div className="min-w-0 flex-1">
                <p className="truncate font-serif text-[16px] font-bold text-white">GrantBot</p>
                <p className="truncate text-[11.5px] text-white/55">
                  Firm <span className="text-white/30">·</span> read-only
                </p>
              </div>
              <div className="flex flex-shrink-0 items-center gap-0.5 pt-px">
                <button
                  type="button"
                  onClick={expand}
                  title="Open full page"
                  aria-label="Open full page"
                  className="inline-flex h-[26px] w-[26px] items-center justify-center rounded-lg text-white/55 transition-colors hover:bg-white/10 hover:text-white"
                >
                  <Maximize2 className="h-3.5 w-3.5" />
                </button>
                <button
                  type="button"
                  onClick={() => setOpen(false)}
                  title="Close"
                  aria-label="Close GrantBot"
                  className="inline-flex h-[26px] w-[26px] items-center justify-center rounded-lg text-white/55 transition-colors hover:bg-white/10 hover:text-white"
                >
                  <X className="h-[15px] w-[15px]" />
                </button>
              </div>
            </div>
          </div>
          {/* The accent rule. Carries no type, so it is `orange` and not `orangeFill`. */}
          <div className="h-0.5 flex-shrink-0 bg-brand-orange" />

          <FirmGrantBotChat variant="corner" />
        </div>
      )}
    </>
  );
}
