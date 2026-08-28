"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Loader2, Sparkles } from "lucide-react";
import { BRAND } from "@/lib/brand";

// The IntellEngine grant-match re-run, living in the (light) IntellEngine box below "Generate
// concept proposal". It is the trigger half of what used to be IntelReviewPanel — the raw
// verdict paragraph + evidence display was removed from the navy Fit Score box (it duplicated
// the merged Fit Factors paragraph), and this keeps only the ACTION: POST the QA pass, then
// refresh so the coalesced score / factors / narrative / "Verified against" sources re-resolve.
//
// It needs only cardId — the route resolves the grant + client from the card. Same apply-aware
// behaviour as before (a grounded demote lowers the displayed score; affirm/flag/unverified
// clear any prior override), it just no longer renders the verdict itself. Staff-only by mount
// point (the portal never renders it). Light-themed for the white box, unlike the old dark panel.
export function IntelRerunButton({ cardId, hasVerdict }: { cardId: string; hasVerdict: boolean }) {
  const router = useRouter();
  const [phase, setPhase] = useState<"idle" | "running" | "error">("idle");
  const [error, setError] = useState<string | null>(null);

  async function run() {
    setPhase("running");
    setError(null);
    try {
      const res = await fetch(`/api/review/${cardId}/intel`, { method: "POST" });
      const data = (await res.json().catch(() => ({}))) as { error?: string; intel?: unknown };
      if (!res.ok || !data.intel) throw new Error(data.error || "QA couldn't run");
      setPhase("idle");
      // The apply-write may have moved the coalesced qa_* score/factors/sources/narrative, which
      // are server-rendered. Re-resolve the page so those reflect the verdict without a manual
      // reload (the verdict itself is no longer shown here — the score/factors/sources are).
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "QA couldn't run");
      setPhase("error");
    }
  }

  const running = phase === "running";

  return (
    <div className="flex flex-col items-start gap-1">
      <button
        type="button"
        disabled={running}
        onClick={() => void run()}
        className="inline-flex items-center gap-[7px] text-[12.5px] font-semibold text-brand-navy transition-colors hover:opacity-80 disabled:opacity-60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-orange/60 focus-visible:ring-offset-2"
      >
        {running ? (
          <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
        ) : (
          <Sparkles className="h-3.5 w-3.5" aria-hidden="true" />
        )}
        {running ? "Re-running… (up to a few minutes)" : hasVerdict ? "Re-run grant match" : "Run grant match review"}
      </button>
      <p className="text-[11px] leading-[1.45] text-ink-muted">
        Opus + web re-check of this pair against the authoritative source. A grounded demote can lower this card&rsquo;s score.
      </p>
      {error && <p className="text-[11px]" style={{ color: BRAND.reject }}>{error}</p>}
    </div>
  );
}
