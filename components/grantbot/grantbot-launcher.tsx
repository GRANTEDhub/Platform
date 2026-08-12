"use client";

import { useCallback, useEffect, useState } from "react";
import dynamic from "next/dynamic";
import { useRouter } from "next/navigation";
import { Loader2, Maximize2, MessagesSquare, X } from "lucide-react";

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
}: {
  clientId: string;
  clientName: string;
  startOpen?: boolean;
  startConversationId?: string | null;
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
      if (e.key === "Escape") setOpen(false);
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
  function expand() {
    router.push(`/clients/${clientId}/grantbot${convId ? `?c=${convId}` : ""}`);
  }

  return (
    <>
      {!open && (
        <button
          type="button"
          onClick={openPanel}
          className="fixed bottom-6 right-6 z-40 inline-flex h-11 items-center gap-2 rounded-pill bg-brand-navy px-4 text-[13px] font-medium text-white shadow-lg transition-colors hover:bg-brand-navy/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-orange/60 focus-visible:ring-offset-2"
        >
          <MessagesSquare className="h-4 w-4" />
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
          className={`fixed bottom-6 right-6 z-40 flex h-[min(34rem,calc(100vh-6rem))] w-[min(27rem,calc(100vw-3rem))] flex-col overflow-hidden rounded-2xl border border-brand-navy/10 bg-page shadow-2xl transition-all duration-200 ${
            open && shown ? "visible translate-y-0 opacity-100" : "invisible translate-y-3 opacity-0"
          }`}
        >
          <div className="flex items-center justify-between gap-2 border-b border-brand-navy/10 bg-brand-navy px-4 py-2.5">
            <div className="min-w-0">
              <p className="truncate text-[13px] font-semibold text-white">GrantBot</p>
              <p className="truncate text-[11px] text-white/60">
                {clientName} · read-only
              </p>
            </div>
            <div className="flex items-center gap-1">
              <button
                type="button"
                onClick={expand}
                title="Open full page"
                aria-label="Open full page"
                className="rounded-lg p-1.5 text-white/70 transition-colors hover:bg-white/10 hover:text-white"
              >
                <Maximize2 className="h-4 w-4" />
              </button>
              <button
                type="button"
                onClick={() => setOpen(false)}
                title="Close"
                aria-label="Close GrantBot"
                className="rounded-lg p-1.5 text-white/70 transition-colors hover:bg-white/10 hover:text-white"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
          </div>

          <GrantBotChat
            clientId={clientId}
            clientName={clientName}
            variant="corner"
            initialConversationId={startConversationId}
            onConversationChange={onConversationChange}
          />
        </div>
      )}
    </>
  );
}
