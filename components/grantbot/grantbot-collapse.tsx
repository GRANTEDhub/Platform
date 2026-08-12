"use client";

import { useRouter } from "next/navigation";
import { Minimize2 } from "lucide-react";
import { BLANK_CONVERSATION } from "@/lib/grantbot/wire";

// The full page's Collapse control: back to the client record with the corner panel reopened
// on the conversation being read.
//
// ── WHY THIS IS A CLIENT COMPONENT AND NOT A <Link> ──
//
// The href has to name the LIVE conversation, and on this page that is not knowable at server
// render time. Arrive at ?c=new (expanded from a started-but-unsent conversation), send a
// message, and a conversation now exists that the server-rendered href predates -- so a plain
// Link would still say `new` and collapse into a blank panel, losing the thread that was just
// created. That is the same broken promise as the outbound half of this trip, one leg later.
//
// GrantBotChat keeps ?c in step as soon as a conversation materialises, so reading the param
// at CLICK time is what makes the round trip exact. The server-rendered `fallback` covers the
// first paint and the no-JS case.
export function GrantBotCollapse({
  clientId,
  clientName,
  fallbackConversationId,
}: {
  clientId: string;
  clientName: string;
  // What the server knew when it rendered: the active conversation, or null for a blank one.
  fallbackConversationId: string | null;
}) {
  const router = useRouter();

  function collapse() {
    const live =
      typeof window !== "undefined"
        ? new URL(window.location.href).searchParams.get("c")
        : null;
    // `new` in the URL is the blank sentinel, not an id -- fall through to it rather than
    // handing it back as though it named a conversation.
    const id = live && live !== BLANK_CONVERSATION ? live : fallbackConversationId;
    router.push(`/clients/${clientId}?grantbot=${id ?? BLANK_CONVERSATION}`);
  }

  return (
    <button
      type="button"
      onClick={collapse}
      className="inline-flex items-center gap-1.5 text-[13px] font-medium text-brand-navy/70 transition-colors hover:text-brand-navy"
    >
      <Minimize2 className="h-3.5 w-3.5" /> Collapse to {clientName}
    </button>
  );
}
