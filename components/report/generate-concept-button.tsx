"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Loader2, Sparkles } from "lucide-react";
import type { ConceptProposalStatus } from "@/types/database";

// The prospect review's top-of-page "Generate concept proposal" action, sitting
// beside "Send grant alert". A single click kicks off generation server-side and
// refreshes so the panel below reflects it — no scroll-and-click-again. Once a
// proposal exists it steps aside (view / edit / regenerate live in the panel below).
export function GenerateConceptButton({
  cardId,
  status,
}: {
  cardId: string;
  status: ConceptProposalStatus | null;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);

  if (busy || status === "generating") {
    return (
      <div className="inline-flex h-10 w-full items-center justify-center gap-2 rounded-full bg-brand-orange/10 px-5 text-sm font-semibold text-brand-orange">
        <Loader2 className="h-4 w-4 animate-spin" />
        Generating concept proposal…
      </div>
    );
  }
  if (status === "ready") {
    return (
      <div className="inline-flex h-10 w-full items-center justify-center gap-2 rounded-full bg-emerald-50 px-5 text-sm font-semibold text-emerald-700">
        ✓ Concept proposal ready — below
      </div>
    );
  }

  async function generate() {
    setBusy(true);
    try {
      const res = await fetch(`/api/concept/${cardId}`, { method: "POST" });
      if (!res.ok) {
        setBusy(false);
        return;
      }
      // Leave busy true — the refresh re-renders with status='generating', which
      // swaps this to the spinner chip; the panel below then polls to ready.
      router.refresh();
    } catch {
      setBusy(false);
    }
  }

  return (
    <button
      onClick={generate}
      className="inline-flex h-10 w-full items-center justify-center gap-1.5 rounded-full bg-brand-orange px-5 text-sm font-semibold text-white transition hover:bg-brand-orange/90"
    >
      <Sparkles className="h-4 w-4" />
      {status === "error" ? "Retry concept proposal" : "Generate concept proposal"}
    </button>
  );
}
