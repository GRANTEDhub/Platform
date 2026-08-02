"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { ArrowRight, Loader2, Sparkles } from "lucide-react";
import { BRAND } from "@/lib/brand";
import type { ConceptProposalStatus } from "@/types/database";

// The concept-proposal card in the grant review rail.
//
// COMPACT ON PURPOSE. The state it is in most often is "not started", and the previous
// treatment for that was a large dashed placeholder — which reads as a failed render, not
// as an offer. Four lines and a full-width button says the same thing without claiming
// space it has not earned.
//
// It is the third question the page asks, and last for a reason: the concept proposal
// exists to carry the mitigation the rationale names to the client, so it only makes
// sense after the score and its weakness have been read.
//
// ONCE GENERATED IT EXPANDS INLINE below, with editing in a right-hand pane. That state
// is not built here, but the card must not be written as though it will stay small
// forever — hence the status-driven body rather than a hardcoded empty one.

export function ConceptCard({
  cardId,
  status,
  anchorHref,
}: {
  cardId: string;
  status: ConceptProposalStatus | null;
  // Where "View the draft" goes once one exists — the panel further down the page.
  anchorHref: string;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const generating = busy || status === "generating";

  async function generate() {
    setBusy(true);
    try {
      const res = await fetch(`/api/concept/${cardId}`, { method: "POST" });
      if (!res.ok) {
        setBusy(false);
        return;
      }
      // Leave busy true — the refresh re-renders at status='generating', which keeps the
      // spinner until the panel below polls to ready.
      router.refresh();
    } catch {
      setBusy(false);
    }
  }

  const statusWord = generating ? "Drafting" : status === "ready" ? "Drafted" : status === "error" ? "Failed" : "Not started";

  return (
    <section
      className="shrink-0 rounded-sharp border border-edge bg-white px-[17px] pb-[13px] pt-3"
      style={{ borderLeftWidth: "3px", borderLeftColor: BRAND.chrome }}
    >
      <div className="flex items-center gap-[9px]">
        <Sparkles className="h-3.5 w-3.5 shrink-0" style={{ color: BRAND.orangeDeep }} aria-hidden="true" />
        <p className="text-[10px] font-bold uppercase tracking-[0.13em] text-ink-muted">Concept proposal</p>
        <span className="ml-auto shrink-0 text-[11px] text-ink-muted">{statusWord}</span>
      </div>

      <p className="mt-2 text-[12px] leading-[1.5] text-ink-muted">
        {status === "ready"
          ? "Scope, budget frame and named consortium partners — ready to review below."
          : "Scope, budget frame and named consortium partners."}
      </p>

      {status === "ready" ? (
        <a
          href={anchorHref}
          className="mt-2.5 inline-flex h-[34px] w-full items-center justify-center gap-[7px] rounded-sharp border border-edge text-[12.5px] font-semibold text-brand-navy transition-colors hover:border-brand-navy/25 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-orange/60 focus-visible:ring-offset-2"
        >
          View the draft
          <ArrowRight className="h-3.5 w-3.5" aria-hidden="true" />
        </a>
      ) : (
        <button
          type="button"
          disabled={generating}
          onClick={generate}
          className="mt-2.5 inline-flex h-[34px] w-full items-center justify-center gap-[7px] rounded-sharp bg-brand-chrome text-[12.5px] font-semibold text-white transition-opacity duration-[120ms] hover:opacity-90 disabled:opacity-70 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-orange/60 focus-visible:ring-offset-2"
        >
          {generating ? (
            <>
              <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
              Generating…
            </>
          ) : (
            <>
              <Sparkles className="h-3.5 w-3.5" aria-hidden="true" />
              {status === "error" ? "Retry concept proposal" : "Generate concept proposal"}
            </>
          )}
        </button>
      )}
    </section>
  );
}
