"use client";

import { useRouter } from "next/navigation";
import { Sparkles } from "lucide-react";
import { BRAND } from "@/lib/brand";
import { stashAskContext, askOpenHref } from "@/lib/grantbot/ask-intent";
import { dispatchOpenGrantBot } from "@/lib/grantbot/switcher";

// "Ask GrantBot about this grant" — the button on the grant card's IntellEngine tile (above Generate
// concept proposal). One click opens the per-client GrantBot at a NEW thread ANCHORED to this grant:
// it stashes the grant anchor (grantId + title), then opens the corner. From there the thread is
// auto-named after the grant and grounded on it, so the staffer just asks — the three starter chips
// render inside the new thread (see grantbot-chat.tsx). All the anchor mechanics live in
// lib/grantbot/ask-intent.ts; this is only the affordance.
//
// OPENING — in place, not a bounce. The Switcher is already mounted on this page, so when it is live we
// open the corner IN PLACE via a window event (dispatchOpenGrantBot) and the staffer stays on the grant
// card. When the Switcher flag is OFF we fall back to the dashboard open-blank deep-link (the launcher
// path) — which does navigate, but that is today's behavior for the launcher and only reachable with the
// Switcher off. `switcherEnabled` is read server-side (not NEXT_PUBLIC) and threaded down as a prop.
//
// It renders inside ConceptCard (the IntellEngine box), which the client portal never mounts — so it is
// staff-only by construction. Visual language matches the box (navy + orange sparkle); lighter than the
// chrome "Generate concept proposal" so that stays the primary action, but it sits first.
export function AskGrantBotButton({
  clientId,
  grantId,
  grantTitle,
  switcherEnabled,
}: {
  clientId: string;
  grantId: string;
  grantTitle: string;
  switcherEnabled: boolean;
}) {
  const router = useRouter();

  function ask() {
    // Anchor first, then open: the corner chat reads-and-clears the anchor on mount and opens the new
    // thread tied to this grant. The anchor lives under its own key, so it never touches an unsent draft.
    stashAskContext(clientId, { grantId, grantTitle });
    if (switcherEnabled) {
      // In place — the mounted Switcher opens the corner on this client without leaving the grant card.
      dispatchOpenGrantBot(clientId);
    } else {
      // Switcher off: the launcher honours the dashboard deep-link, so navigate there (today's path).
      router.push(askOpenHref(clientId));
    }
  }

  return (
    <div className="mt-[11px]">
      <button
        type="button"
        onClick={ask}
        className="inline-flex h-[34px] w-full items-center justify-center gap-[7px] rounded-sharp border border-edge text-[12.5px] font-semibold text-brand-navy transition-colors hover:border-brand-navy/25 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-orange/60 focus-visible:ring-offset-2"
      >
        <Sparkles className="h-3.5 w-3.5" style={{ color: BRAND.orange }} aria-hidden="true" />
        Ask GrantBot
      </button>
      <p className="mt-2 text-[12px] leading-[1.5] text-ink-muted">
        Opens a thread tied to this grant — ask who wins it, prime-vs-sub eligibility, or the deadline reality.
      </p>
    </div>
  );
}
