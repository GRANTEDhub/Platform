"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Loader2, RefreshCw } from "lucide-react";
import { BRAND } from "@/lib/brand";

// Re-extract a grant's allowable / not-allowed uses of funds on demand — the "I'm about to
// forward THIS grant, refresh its use-of-funds first" trigger, living in the (light) IntellEngine
// box beside the grant-match re-run. It only needs the grantId; the route re-runs the SAME
// generate+save path the throttled hourly recut uses (NO new extract logic here — this is only the
// trigger) and stamps the current finder generation, so on refresh the OverviewCard's "Uses of
// funds" block re-renders with the fresh lists.
//
// STAFF-ONLY, three ways over: (1) by MOUNT POINT — it rides the ConceptCard `reextract` slot the
// staff roadmap passes; the client portal builds its OWN read-only concept slot and never renders
// this. (2) By GATE — the roadmap passes it only under `showIntel` (admin + pending + not released).
// (3) By ROUTE — /api/admin/reextract-allowable-uses is admin-gated (403 for non-admins), so even a
// forged POST from a client session can't run it. Nothing in the shared frame forks on actor.
//
// A bare re-extract HOLDS a regression (the fresh run came back thinner than the stored list) rather
// than clobbering a good list; this surfaces the hold and offers a deliberate "Overwrite anyway"
// (force) re-send, exactly as the route intends — never a silent no-op on a hold.
export function AllowableRefreshButton({ grantId }: { grantId: string }) {
  const router = useRouter();
  const [phase, setPhase] = useState<"idle" | "running" | "held" | "error">("idle");
  const [message, setMessage] = useState<string | null>(null);

  async function run(force: boolean) {
    setPhase("running");
    setMessage(null);
    try {
      const res = await fetch("/api/admin/reextract-allowable-uses", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(force ? { grantId, force: true } : { grantId }),
      });
      const data = (await res.json().catch(() => ({}))) as {
        error?: string;
        ok?: boolean;
        saved?: boolean;
        held?: string;
        message?: string;
        itemCount?: number;
      };
      if (!res.ok || data.ok === false) throw new Error(data.error || "Re-extract couldn't run");
      if (data.saved === false && data.held === "regression") {
        // Thinner result held back — do NOT refresh (nothing changed); offer a deliberate overwrite.
        setMessage(data.message || "Held: the fresh run was thinner than the stored list.");
        setPhase("held");
        return;
      }
      // Saved — the grant's use-of-funds column changed; refresh so the OverviewCard re-renders it.
      setMessage(typeof data.itemCount === "number" ? `Refreshed — ${data.itemCount} item(s).` : "Refreshed.");
      setPhase("idle");
      router.refresh();
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "Re-extract couldn't run");
      setPhase("error");
    }
  }

  const running = phase === "running";

  return (
    <div>
      {/* A bordered SECONDARY action — deliberately lighter than the two navy IntellEngine buttons
          above it (Generate concept, Re-run match): this is grant-level maintenance, not a match
          action, and three stacked navy blocks would read as one heavy stack. */}
      <button
        type="button"
        disabled={running}
        onClick={() => void run(false)}
        className="inline-flex h-[34px] w-full items-center justify-center gap-[7px] rounded-sharp border border-edge text-[12.5px] font-semibold text-brand-navy transition-colors hover:border-brand-navy/25 disabled:opacity-70 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-orange/60 focus-visible:ring-offset-2"
      >
        {running ? (
          <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
        ) : (
          <RefreshCw className="h-3.5 w-3.5" aria-hidden="true" />
        )}
        {running ? "Re-extracting…" : "Re-extract uses of funds"}
      </button>
      <p className="mt-2 text-[12px] leading-[1.5] text-ink-muted">
        Re-pull the allowable and not-allowed uses from the notice.
      </p>
      {phase === "held" && (
        <div className="mt-1.5">
          <p className="text-[11px] leading-[1.5] text-ink-muted">{message}</p>
          <button
            type="button"
            onClick={() => void run(true)}
            className="mt-1 text-[11px] font-semibold underline hover:no-underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-orange/60 focus-visible:ring-offset-2"
            style={{ color: BRAND.orangeDeep }}
          >
            Overwrite anyway
          </button>
        </div>
      )}
      {phase === "error" && (
        <p className="mt-1 text-[11px]" style={{ color: BRAND.reject }}>
          {message}
        </p>
      )}
      {phase === "idle" && message && <p className="mt-1 text-[11px] text-ink-muted">{message}</p>}
    </div>
  );
}
