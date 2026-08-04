"use client";

import { useEffect, useRef } from "react";

// Fire-and-forget: opening a grant marks it read on whichever side you are.
//
// Renders nothing. It exists because the stamp cannot happen during the page's server
// render -- see the mark-read route for why (the client Router Cache serves a stale report
// on the way back, and revalidatePath, the only thing that clears it, is not callable from
// a render).
//
// GUARDED AGAINST FIRING TWICE. React Strict Mode double-invokes effects in development,
// and the route is cheap but not free -- it revalidates two paths. The ref makes it once
// per mount. Beyond that the write itself is idempotent (first read wins), so a duplicate
// would be harmless rather than wrong.
//
// No error handling and no loading state on purpose: a read stamp is bookkeeping. If it
// fails the row stays unread, which is honest and self-corrects the next time the page is
// opened. Nothing on screen should flicker for it.
export function MarkRead({ cardId }: { cardId: string }) {
  const fired = useRef(false);

  useEffect(() => {
    if (fired.current) return;
    fired.current = true;
    void fetch("/api/review/mark-read", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ cardId }),
    }).catch(() => {
      // Deliberately silent -- see above.
    });
  }, [cardId]);

  return null;
}
