"use client";

import { useCallback, useEffect, useState } from "react";
import dynamic from "next/dynamic";
import { useRouter } from "next/navigation";
import { Loader2, Maximize2, Sparkles, X } from "lucide-react";
import { BRAND } from "@/lib/brand";
import { BLANK_CONVERSATION } from "@/lib/grantbot/wire";

// The chat arrives on first open, not with the client record. "Opening is free" would be a
// half-truth if the transcript were free and its code were not: this mounts on a page staff open
// constantly and most visits never ask GrantBot anything.
const GrantBotChat = dynamic(() => import("./grantbot-chat").then((m) => m.GrantBotChat), {
  ssr: false,
  loading: () => (
    <p className="flex flex-1 items-center gap-2 p-4 text-[13px] text-muted-foreground">
      <Loader2 className="h-3.5 w-3.5 animate-spin" /> Opening…
    </p>
  ),
});

// The GrantBot launcher: a bubble in the bottom-right of the client record, and the panel it
// opens. Where GrantBot lives now that it is not a destination.
//
// ── WHY IT STOPPED BEING A PAGE YOU NAVIGATE TO ──
//
// The questions it answers are asked WHILE looking at the client -- a deadline in the report, a
// seat on a match, a thread someone just forwarded. A nav destination made you leave the evidence
// to ask about it, and made the asking a decision. A corner panel makes it an aside.
//
// ── PER CLIENT, BY MOUNT POINT ──
//
// clientId is a prop from the page this is mounted on, so the bubble on NWACC's record is
// NWACC's GrantBot and nothing else can be true: the turn route re-checks that the conversation
// belongs to the client, the read route does the same, and 0080 keys both tables on client_id.
// There is no global chat to accidentally build.
//
// It is also mounted OUTSIDE ClientDashboard on a staff-only route, deliberately: that component
// is the shared actor-aware hub the client portal will mount too (Phase 2), and GrantBot's context
// pack contains internal staff notes. Keeping the launcher out of it means the portal cannot
// inherit this by rendering the same component.
//
// ── OPENING IS FREE, AND STAYS FREE ──
//
// Nothing is fetched until the bubble is clicked, and after that the panel stays MOUNTED but
// hidden, so closing it keeps your draft and your place in the thread. The transcript itself is
// server-side, so it also survives the tab closing entirely -- come back tomorrow and the
// conversation is where you left it.
export function GrantBotLauncher({
  clientId,
  clientName,
  // Returning from the full page ("Collapse to corner") lands here with the panel already open on
  // the conversation that was being read.
  startOpen = false,
  startConversationId = null,
  startBlank = false,
}: {
  clientId: string;
  clientName: string;
  startOpen?: boolean;
  startConversationId?: string | null;
  // Collapsed back from a conversation that had been started but never sent: open blank rather
  // than falling through to the most recent thread.
  startBlank?: boolean;
}) {
  const router = useRouter();
  const [everOpened, setEverOpened] = useState(startOpen);
  const [open, setOpen] = useState(startOpen);
  const [shown, setShown] = useState(false);
  const [convId, setConvId] = useState<string | null>(startConversationId);

  // Separate from `open` so the panel transitions in rather than appearing: it has to be in the
  // tree at its start position for one frame before the end position can animate.
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
      if (e.key === "Escape") close();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  // Identity-stable, so it does not re-fire GrantBotChat's report effect every render.
  const onConversationChange = useCallback((id: string | null) => setConvId(id), []);

  function openPanel() {
    setEverOpened(true);
    setOpen(true);
  }

  // Expand = the page that already exists, carrying the conversation. Not a second full-screen
  // rendering of the panel: one full-page GrantBot, with a URL worth sharing, and no chance of
  // the two drifting.
  //
  // A null convId means a started-but-unsent conversation, which has no id to carry -- and
  // omitting ?c entirely tells the page "no preference", which lands on the most recent thread
  // instead of the blank one being expanded. So say blank explicitly.
  function expand() {
    router.push(`/clients/${clientId}/grantbot?c=${convId ?? BLANK_CONVERSATION}`);
  }

  // Closing has to clear ?grantbot= as well as the open flag. The param is written by the full
  // page's Collapse link and read server-side into `startOpen`, so a close that left it in place
  // meant the next refresh (or a shared copy of that URL) reopened the panel the reader had just
  // dismissed.
  //
  // history.replaceState, not router.replace: the param is only ever read on the initial server
  // render, and router.replace would refetch and re-render the whole client dashboard underneath
  // the panel -- the exact cost this component was built to avoid. Guarded on the param actually
  // being present, so the common bubble-opened case touches nothing.
  function close() {
    setOpen(false);
    if (typeof window === "undefined") return;
    const url = new URL(window.location.href);
    if (!url.searchParams.has("grantbot")) return;
    url.searchParams.delete("grantbot");
    window.history.replaceState(window.history.state, "", url.toString());
  }

  return (
    <>
      {!open && (
        <button
          type="button"
          onClick={openPanel}
          className="fixed bottom-7 right-7 z-40 inline-flex h-11 items-center gap-2 rounded-pill bg-brand-navy px-4 text-[13px] font-medium text-white shadow-overlay transition-colors hover:bg-brand-navyHover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-orange/60 focus-visible:ring-offset-2"
        >
          {/* Same mark as the panel header's tile, so the thing you click and the thing that
              opens are recognisably one object. */}
          <Sparkles className="h-4 w-4" style={{ color: BRAND.orange }} />
          Ask GrantBot
        </button>
      )}

      {everOpened && (
        <div
          // Non-modal on purpose: the page underneath stays live, because the whole point is
          // asking about what you are looking at. So no focus trap and no backdrop -- and z-40,
          // under the nav's menus and any real dialog, which should cover this rather than fight
          // it.
          role="dialog"
          aria-label={`GrantBot — ${clientName}`}
          // Kept in the tree while closed so the draft survives, but out of the a11y tree and out
          // of hit-testing -- `invisible` does both, and unlike `hidden` it still transitions.
          aria-hidden={!open}
          // No border: the shadow alone lifts it off the page. A 1px navy rule under a cast
          // that deep reads as a seam around the panel rather than an edge to it.
          className={`fixed bottom-7 right-7 z-40 flex h-[min(588px,calc(100vh-3.5rem))] w-[min(404px,calc(100vw-3.5rem))] flex-col overflow-hidden rounded-2xl bg-white shadow-floating transition-all duration-[280ms] ease-entrance ${
            open && shown
              ? "visible translate-y-0 scale-100 opacity-100"
              : "invisible translate-y-4 scale-[0.98] opacity-0"
          }`}
        >
          <div className="relative flex-shrink-0 overflow-hidden bg-brand-navy px-[18px] pb-3.5 pt-4">
            {/* The accent bloom, bled off the top-right corner. Decoration, so it is
                aria-hidden and pointer-events-none -- and it is BRAND.orangeGlow rather than a
                fresh rgba, so there is still exactly one orange in the product. */}
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
                {/* Serif, because this is a title and not a control label -- the same
                    Libre Baskerville that carries every heading in the product. */}
                <p className="truncate font-serif text-[16px] font-bold text-white">GrantBot</p>
                <p className="truncate text-[11.5px] text-white/55">
                  {clientName} <span className="text-white/30">·</span> read-only
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
                  onClick={close}
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

          <GrantBotChat
            clientId={clientId}
            clientName={clientName}
            variant="corner"
            initialConversationId={startConversationId}
            initialBlank={startBlank}
            onConversationChange={onConversationChange}
          />
        </div>
      )}
    </>
  );
}
