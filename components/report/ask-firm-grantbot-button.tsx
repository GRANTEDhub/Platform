"use client";

import { useRouter } from "next/navigation";
import { Sparkles } from "lucide-react";
import { BRAND } from "@/lib/brand";
import { stashFirmAskContext } from "@/lib/grantbot/firm-ask-intent";
import { dispatchOpenFirmGrantBot } from "@/lib/grantbot/switcher";

// "Ask GrantBot" on the prospecting page (/intel/[id]). One click opens the FIRM GrantBot at a NEW thread
// anchored to THIS grant + its surfaced prospects: it stashes the grant anchor, then opens the firm corner
// IN PLACE (the Switcher is already mounted on this page), so the staffer stays on the prospecting page.
// The firm bot already reads the whole client roster; the anchor hands it this grant + the surfaced
// prospects so the staffer can ask "why did you surface X over the others?" with nothing retyped. All the
// anchor mechanics live in firm-ask-intent.ts; this is only the affordance.
//
// OPENING — in place, not a bounce. Switcher ON (prod default): dispatchOpenFirmGrantBot opens the corner
// on Firm at a new blank anchored thread. Switcher OFF: navigate to the firm full page with ?ask=1 (a
// blank thread there); the grant anchor rides sessionStorage across the navigation. switcherEnabled is
// read server-side (not NEXT_PUBLIC) and threaded down as a prop.
//
// It renders on /intel/[id], which is admin-only (requireAdmin), and the page renders it only when the
// firm bot + the ask flag are on — so it is staff/admin-only by construction and the firm bot is always
// reachable for whoever sees it.
export function AskFirmGrantBotButton({
  grantId,
  grantTitle,
  switcherEnabled,
}: {
  grantId: string;
  grantTitle: string;
  switcherEnabled: boolean;
}) {
  const router = useRouter();

  function ask() {
    // Anchor first, then open: the firm chat reads-and-clears the anchor on mount and opens the new
    // thread tied to this grant. The anchor lives under its own firm key, so it touches no composer draft.
    stashFirmAskContext({ grantId, grantTitle });
    if (switcherEnabled) {
      dispatchOpenFirmGrantBot();
    } else {
      router.push("/grantbot?ask=1");
    }
  }

  return (
    <button
      type="button"
      onClick={ask}
      title="Ask GrantBot about this grant and its surfaced prospects"
      className="inline-flex h-8 items-center gap-1.5 rounded-sharp border border-edge px-3 text-[12px] font-semibold text-brand-navy transition-colors hover:border-brand-navy/25 hover:bg-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-orange/60 focus-visible:ring-offset-2"
    >
      <Sparkles className="h-3.5 w-3.5" style={{ color: BRAND.orange }} aria-hidden="true" />
      Ask GrantBot
    </button>
  );
}
