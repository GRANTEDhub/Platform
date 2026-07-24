"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

// Staff's OWN Gate-2 control for an account-managed client (0059) -- shown
// INSTEAD of the normal DecisionBar on the staff roadmap detail, since the
// relevant call here is "release to the client" (with a concept proposal --
// not built yet), not a pursue decision. The client makes the actual pursue
// call later, on their own copy of this same page. Reject is terminal
// (decision='passed'), identical in effect to a client-side Pass.
export function ReleaseToClientBar({ cardId, released }: { cardId: string; released: boolean }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function act(body: Record<string, unknown>) {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/review/${cardId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Couldn't save that");
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't save that");
    } finally {
      setBusy(false);
    }
  }

  if (released) {
    return (
      <div className="mt-6 border-t border-brand-navy/[0.06] pt-6">
        <p className="text-[13px] text-muted-foreground">
          Released to the client — they now see this in their own Grant Alerts.
        </p>
      </div>
    );
  }

  return (
    <div className="mt-6 border-t border-brand-navy/[0.06] pt-6">
      <p className="text-[11px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">
        Account-managed — your review
      </p>
      <p className="mt-1.5 text-[13px] text-muted-foreground">
        This client's matches go through your review first. Release to send it to their Grant Alerts, or
        reject to archive it now.
      </p>
      <div className="mt-3 flex flex-wrap items-center gap-3">
        <button
          disabled={busy}
          onClick={() => act({ sme_release: true })}
          className="rounded-full bg-brand-navy px-6 py-2.5 text-sm font-semibold text-white shadow-soft transition hover:bg-brand-navyDeep disabled:opacity-50"
        >
          Release to client
        </button>
        <button
          disabled={busy}
          onClick={() => act({ decision: "passed" })}
          className="px-3 py-2 text-sm font-medium text-destructive/80 transition hover:text-destructive hover:underline disabled:opacity-50"
        >
          Reject
        </button>
      </div>
      {error && <p className="mt-3 text-sm text-destructive">{error}</p>}
    </div>
  );
}
