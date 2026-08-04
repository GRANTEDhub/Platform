"use client";

import { useEffect, useRef } from "react";
import { useRouter } from "next/navigation";

// Fire-and-forget: opening a grant marks it read on whichever side you are.
//
// Renders nothing. It exists because the stamp cannot happen during the page's server
// render -- a mutation does not belong there, and the route it calls is what can reach
// revalidatePath at all.
//
// router.refresh() IS LOAD-BEARING, NOT BELT-AND-BRACES. revalidatePath() inside a ROUTE
// HANDLER clears the server-side Data and Full Route caches, and nothing else: the browser's
// client-side Router Cache is only invalidated by a SERVER ACTION's response (Next piggybacks
// the invalidation onto it) or by router.refresh(). A plain fetch() to a route handler carries
// no such signal. So the first version of this fixed the server half and left the exact
// symptom it was written for -- the report list still painting the row unread on the way back
// -- fully intact. Caught in review on #308; the PR body claimed a fix that did not work.
//
// refresh() invalidates the Router Cache and re-fetches the current route, so the report
// entry is gone by the time a back-navigation asks for it.
//
// GUARDED AGAINST FIRING TWICE. React Strict Mode double-invokes effects in development, and
// refresh() itself re-renders the server component tree -- without the ref that is a loop.
// The ref survives refresh() because refresh preserves client state, so this runs once per
// real mount. The write is idempotent anyway (first read wins), so a duplicate POST would be
// harmless rather than wrong.
//
// No error handling and no loading state on purpose: a read stamp is bookkeeping. If it fails
// the row stays unread, which is honest and self-corrects on the next visit, and nothing on
// screen should flicker for it.
export function MarkRead({ cardId }: { cardId: string }) {
  const router = useRouter();
  const fired = useRef(false);

  useEffect(() => {
    if (fired.current) return;
    fired.current = true;
    void fetch("/api/review/mark-read", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ cardId }),
    })
      .then((res) => {
        // Only on a real write. Refreshing after a 401/500 would spend a round trip to
        // re-render identical output.
        if (res.ok) router.refresh();
      })
      .catch(() => {
        // Deliberately silent -- see above.
      });
  }, [cardId, router]);

  return null;
}
