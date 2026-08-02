"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Loader2, Sparkle } from "lucide-react";

// The control that fills in a missing per-factor breakdown, shown in the empty fit-factors
// panel on cards that predate factor scoring (migration 0038, 27 Jul).
//
// IT EXISTS BECAUSE THE OLD COPY POINTED AT NOTHING. The panel used to say the breakdown
// would stay missing "unless this pair is scored again", which was true and useless —
// there was no way to score it again. See app/api/review/[id]/score-factors for what the
// route does and, more importantly, what it refuses to touch.
//
// THE BUTTON SAYS WHAT IT COSTS. It runs the full matcher, so it is slow and it is not
// free, and a reviewer deciding whether to spend it deserves to know that before pressing
// rather than after waiting.
//
// DRIFT DOES NOT AUTO-REFRESH. On a clean run the page reloads straight into the new
// breakdown. When today's run reaches a DIFFERENT fit score than the one on the card, the
// refresh would wipe the only notice of it off the screen — so that case holds, states
// both numbers, and makes reloading the reviewer's own next click.

type Phase = "idle" | "scoring" | "drift" | "error";

export function ScoreFactorsBackfill({ cardId }: { cardId: string }) {
  const router = useRouter();
  const [phase, setPhase] = useState<Phase>("idle");
  const [drift, setDrift] = useState<{ stored: number | null; fresh: number | null }>({ stored: null, fresh: null });
  const [error, setError] = useState<string | null>(null);

  async function run() {
    setPhase("scoring");
    setError(null);
    try {
      const res = await fetch(`/api/review/${cardId}/score-factors`, { method: "POST" });
      const data = (await res.json().catch(() => ({}))) as {
        error?: string;
        drifted?: boolean;
        storedFitScore?: number | null;
        freshFitScore?: number | null;
      };
      if (!res.ok) throw new Error(data.error || "Couldn't score that");
      if (data.drifted) {
        setDrift({ stored: data.storedFitScore ?? null, fresh: data.freshFitScore ?? null });
        setPhase("drift");
        return;
      }
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't score that");
      setPhase("error");
    }
  }

  if (phase === "drift") {
    return (
      <div className="pt-2">
        <p className="text-[12.5px] leading-[1.5] text-ink-muted">
          Breakdown saved. Scored today, the engine rates this pair{" "}
          <strong className="font-semibold text-brand-navy">{drift.fresh} of 3</strong>, not the {drift.stored} on this
          card. The card&apos;s score, seat and role are unchanged — only the six factor ratings were written.
        </p>
        <button
          type="button"
          onClick={() => router.refresh()}
          className="mt-2.5 inline-flex h-8 items-center rounded-sharp border border-edge bg-white px-3 text-[12.5px] font-semibold text-brand-navy transition-colors hover:border-brand-navy/30"
        >
          Show the breakdown
        </button>
      </div>
    );
  }

  return (
    <div className="pt-2">
      <p className="text-[12.5px] leading-[1.5] text-ink-muted">
        No per-factor breakdown — this card was matched before factor scoring shipped (27 Jul), and existing matches
        are not re-scored in bulk.
      </p>
      <button
        type="button"
        disabled={phase === "scoring"}
        onClick={() => void run()}
        className="mt-2.5 inline-flex h-8 items-center gap-2 rounded-sharp border border-edge bg-white px-3 text-[12.5px] font-semibold text-brand-navy transition-colors hover:border-brand-navy/30 disabled:opacity-60"
      >
        {phase === "scoring" ? (
          <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
        ) : (
          <Sparkle className="h-3.5 w-3.5" aria-hidden="true" />
        )}
        {phase === "scoring" ? "Scoring the six factors…" : "Score the factors for this pair"}
      </button>
      <p className="mt-1.5 text-[11px] leading-[1.45] text-ink-muted">
        {phase === "scoring"
          ? "Runs the full matcher — up to a minute. Don't leave the page."
          : "Runs the full matcher, so it takes up to a minute. Writes the factor ratings only — the fit score, seat and role on this card stay as they are."}
      </p>
      {error && <p className="mt-2 text-[11px] leading-[1.45] text-brand-reject">{error}</p>}
    </div>
  );
}
