"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Loader2, Mail } from "lucide-react";
import { BRAND } from "@/lib/brand";

// Return this one card to unread. Console only — see the mark-unread route for why staff
// never clear the client's side.
//
// IT NAVIGATES AWAY RATHER THAN REFRESHING, and that is load-bearing rather than a UX
// preference. Opening this page is what marks the card read: the server component calls
// markCardRead on render. A router.refresh() would re-run that render and immediately
// re-stamp the row read, so the button would appear to do nothing at all. Leaving for the
// report both avoids the re-stamp and lands you where the change is visible — the row you
// just marked, now white with its unread dot back.
export function MarkUnreadButton({ cardId, backHref }: { cardId: string; backHref: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function markUnread() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/review/mark-unread", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cardIds: [cardId] }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || "Couldn't mark it unread");
      router.push(backHref);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't mark it unread");
      setBusy(false); // Only on failure: on success we are leaving, and re-enabling flashes.
    }
  }

  return (
    <div className="flex flex-col items-start gap-1">
      <button
        type="button"
        disabled={busy}
        onClick={() => void markUnread()}
        className="inline-flex items-center gap-[7px] text-[12px] text-ink-muted transition-colors hover:text-brand-navy disabled:opacity-60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-orange/60 focus-visible:ring-offset-2"
      >
        {busy ? (
          <Loader2 className="h-[13px] w-[13px] animate-spin" aria-hidden="true" />
        ) : (
          <Mail className="h-[13px] w-[13px]" aria-hidden="true" />
        )}
        Mark unread
      </button>
      {error && (
        <p className="text-[11.5px]" style={{ color: BRAND.reject }}>
          {error}
        </p>
      )}
    </div>
  );
}
