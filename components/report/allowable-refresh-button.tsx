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
// forced POST from a client session can't run it. Nothing in the shared frame forks on actor.
//
// SINGLE-SHOT, NEVER force. Re-extraction is a nondeterministic model call, so the route HOLDS a
// regression (the fresh run came back thinner than the stored list) rather than clobbering a good
// list. We deliberately do NOT expose the route's `force` overwrite here: a force re-POST would run
// the model AGAIN and save whatever THAT run produced — not the candidate the hold reported — so it
// could clobber the good list with a different, possibly-thinner result (Codex #492 P2). A safe
// overwrite needs the endpoint to persist the exact seen candidate, which is out of this PR's scope;
// until then a held regression just reports "kept the existing list" and makes no change.
export function AllowableRefreshButton({ grantId }: { grantId: string }) {
  const router = useRouter();
  const [phase, setPhase] = useState<"idle" | "running" | "error">("idle");
  const [message, setMessage] = useState<string | null>(null);

  async function run() {
    setPhase("running");
    setMessage(null);
    try {
      const res = await fetch("/api/admin/reextract-allowable-uses", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ grantId }),
      });
      const data = (await res.json().catch(() => ({}))) as {
        error?: string;
        ok?: boolean;
        saved?: boolean;
        held?: string;
        itemCount?: number;
      };
      // Require POSITIVE confirmation the route succeeded (`data.ok === true`) before trusting the
      // shape. An unparseable / truncated 200 — a proxy interstitial, or a stream cut by the route's
      // 60s budget — decodes to `{}` through the catch; treating that as success would falsely report
      // "Refreshed" on a grant whose list never changed. So anything short of ok:true is an error,
      // mirroring the sibling IntelRerunButton's positive `!data.intel` check.
      if (!res.ok || data.ok !== true) throw new Error(data.error || "Re-extract couldn't run");
      if (data.saved === false && data.held === "regression") {
        // Held, not saved — the fresh run was thinner than the good stored list. Nothing changed, so
        // no refresh; report it honestly rather than offering a re-roll that could clobber the list.
        setMessage("Kept the existing list — the fresh run came back thinner, so nothing changed.");
        setPhase("idle");
        return;
      }
      if (data.saved === true) {
        // Saved — the grant's use-of-funds column changed; refresh so the OverviewCard re-renders it.
        setMessage(typeof data.itemCount === "number" ? `Refreshed — ${data.itemCount} item(s).` : "Refreshed.");
        setPhase("idle");
        router.refresh();
        return;
      }
      // ok:true but neither a clean save nor a recognized hold — an unexpected shape; don't claim success.
      throw new Error("Re-extract returned an unexpected response");
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
        onClick={() => void run()}
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
      {phase === "error" ? (
        <p className="mt-1 text-[11px]" style={{ color: BRAND.reject }}>
          {message}
        </p>
      ) : (
        message && <p className="mt-1 text-[11px] text-ink-muted">{message}</p>
      )}
    </div>
  );
}
