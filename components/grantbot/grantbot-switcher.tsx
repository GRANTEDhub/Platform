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
// ── WHY IT STANDS DOWN ON A CLIENT RECORD PAGE ──
//
// The per-client launcher already owns the corner there, and that bot needs the client's NAME, which
// only the record page has (the layout knows the path, not the name). So on /clients/<id>/* the
// Switcher renders nothing and the launcher shows that client's bot — never a double bubble.
// firmSwitcherVisible(pathname, isAdmin) is re-evaluated on every navigation. S2 gives the Switcher a
// roster picker (and every client's identity with it), at which point it hosts any client bot from
// anywhere and subsumes the launcher.
//
// ── OPENING IS FREE, AND STAYS FREE ──
//
// Nothing is fetched until the bubble is clicked; after that the panel stays MOUNTED but invisible,
// so closing keeps the draft and the place in the thread. The transcript is server-side, so it also
// survives the tab closing entirely.
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

  // Navigating onto a client record page hides the Switcher (the launcher owns that corner). Close
  // the panel too, so returning to a firm page reopens it from the bubble rather than snapping a
  // stale panel back. The transcript is server-side, so nothing is lost.
  useEffect(() => {
    if (!visible) setOpen(false);
  }, [visible]);

  if (!visible) return null;

  function openPanel() {
    setEverOpened(true);
    setOpen(true);
  }

  // Expand = the standalone /grantbot page. It loads the most-recent thread, which after a send is
  // the one open in the corner. (Carrying the exact conversation id into the full page is an S2
  // polish item — the firm page does not read a ?c= param yet.)
  function expand() {
    router.push("/grantbot");
  }

  return (
    <>
      {!open && (
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
          aria-hidden={!open}
          className={`fixed bottom-7 right-7 z-40 flex h-[min(588px,calc(100vh-3.5rem))] w-[min(404px,calc(100vw-3.5rem))] flex-col overflow-hidden rounded-2xl bg-white shadow-floating transition-all duration-[280ms] ease-entrance ${
            open && shown
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
