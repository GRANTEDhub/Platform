"use client";

import { useRouter } from "next/navigation";
import { Sparkles } from "lucide-react";
import { BRAND } from "@/lib/brand";
import { stashAskContext, askOpenHref } from "@/lib/grantbot/ask-intent";

// "Ask GrantBot about this grant" — the button on the grant card's IntellEngine tile (above Generate
// concept proposal). One click opens the per-client GrantBot at a NEW thread ANCHORED to this grant:
// it stashes the grant anchor (grantId + title) and navigates to the corner's open-blank deep-link.
// From there the thread is auto-named after the grant and grounded on it, so the staffer just asks —
// the three starter chips render inside the new thread (see grantbot-chat.tsx). All the open/anchor
// mechanics live in lib/grantbot/ask-intent.ts; this is only the affordance.
//
// It renders inside ConceptCard (the IntellEngine box), which the client portal never mounts — so it is
// staff-only by construction. Visual language matches the box (navy + orange sparkle); lighter than the
// chrome "Generate concept proposal" so that stays the primary action, but it sits first.
export function AskGrantBotButton({
  clientId,
  grantId,
  grantTitle,
}: {
  clientId: string;
  grantId: string;
  grantTitle: string;
}) {
  const router = useRouter();

  function ask() {
    // Anchor first, then open: the corner chat reads-and-clears the anchor on mount and opens the new
    // thread tied to this grant. The anchor lives under its own key, so it never touches an unsent draft.
    stashAskContext(clientId, { grantId, grantTitle });
    router.push(askOpenHref(clientId));
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
