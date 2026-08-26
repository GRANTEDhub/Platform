"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Loader2, RotateCw } from "lucide-react";

// Re-score ONE matched client on demand, from its row in the Ledger's "Matched clients"
// list. The single-card companion to the grant-level "Re-match clients" (whole roster) and
// "Add to a client" (a new pair) — the third calibration tool on this page. See
// app/api/review/[id]/rematch for what the route does and what it refuses.
//
// IT SAYS WHAT IT CAN DO. It runs the full matcher (slow, not free) and, because a re-score
// can drop a card that no longer qualifies, it takes a confirm before it runs.
//
// IT HOLDS A RESULT WORTH READING. A drift (the score moved) or a drop (the row was removed)
// is the whole reason to have run it, and this list does not show the fit score — so those
// states show what happened and make the refresh the reviewer's own next click, rather than
// silently re-rendering the list out from under them. A no-op (unchanged / now pre-filtered)
// just says so.
//
// LEDGER-ONLY, ADMIN-GATED by the caller (canCalibrate). Never mounted on a client surface.

type RematchResult =
  | { kind: "refreshed"; storedFitScore: number | null; freshFitScore: number | null; drifted: boolean }
  | { kind: "dropped"; storedFitScore: number | null; reason: string }
  | { kind: "prefiltered"; reason: string }
  | { kind: "error"; detail: string };

type Phase = "idle" | "confirm" | "scoring" | "result";

export function CardRematchButton({ cardId }: { cardId: string }) {
  const router = useRouter();
  const [phase, setPhase] = useState<Phase>("idle");
  const [result, setResult] = useState<RematchResult | null>(null);

  function reset() {
    setResult(null);
    setPhase("idle");
  }

  async function run() {
    setPhase("scoring");
    try {
      const res = await fetch(`/api/review/${cardId}/rematch`, { method: "POST" });
      const data = (await res.json().catch(() => ({}))) as { error?: string; outcome?: RematchResult };
      if (!res.ok || !data.outcome) throw new Error(data.error || "Couldn't re-match this pair");
      setResult(data.outcome);
      setPhase("result");
    } catch (err) {
      setResult({ kind: "error", detail: err instanceof Error ? err.message : "Couldn't re-match this pair" });
      setPhase("result");
    }
  }

  if (phase === "result" && result) {
    if (result.kind === "dropped") {
      return (
        <ResultNote tone="warn">
          Re-scored and removed — {result.reason}.
          <ResultAction label="Refresh" onClick={() => router.refresh()} />
        </ResultNote>
      );
    }
    if (result.kind === "refreshed") {
      const moved =
        result.storedFitScore !== null && result.freshFitScore !== null && result.drifted
          ? `${result.storedFitScore}/3 → ${result.freshFitScore}/3`
          : `still ${result.freshFitScore ?? result.storedFitScore ?? "?"}/3`;
      return (
        <ResultNote tone="plain">
          Re-scored — {moved}.
          {result.drifted && <ResultAction label="Refresh" onClick={() => router.refresh()} />}
          {!result.drifted && <ResultAction label="Done" onClick={reset} />}
        </ResultNote>
      );
    }
    if (result.kind === "prefiltered") {
      return (
        <ResultNote tone="plain">
          Left unchanged — {result.reason}.
          <ResultAction label="Done" onClick={reset} />
        </ResultNote>
      );
    }
    return (
      <ResultNote tone="warn">
        {result.detail}
        <ResultAction label="Try again" onClick={reset} />
      </ResultNote>
    );
  }

  if (phase === "confirm") {
    return (
      <span className="inline-flex items-center gap-2 text-xs">
        <span className="text-muted-foreground">Re-score?</span>
        <button
          type="button"
          onClick={() => void run()}
          className="font-medium text-foreground underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
        >
          Yes
        </button>
        <button
          type="button"
          onClick={() => setPhase("idle")}
          className="text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
        >
          Cancel
        </button>
      </span>
    );
  }

  return (
    <button
      type="button"
      disabled={phase === "scoring"}
      onClick={() => setPhase("confirm")}
      title="Re-score this client against the grant's stored profile. Can remove the card if it no longer qualifies."
      className="inline-flex items-center gap-1.5 text-xs text-muted-foreground transition-colors hover:text-foreground disabled:opacity-60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
    >
      {phase === "scoring" ? (
        <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
      ) : (
        <RotateCw className="h-3.5 w-3.5" aria-hidden="true" />
      )}
      {phase === "scoring" ? "Re-matching…" : "Re-match"}
    </button>
  );
}

function ResultNote({ tone, children }: { tone: "plain" | "warn"; children: React.ReactNode }) {
  return (
    <span className={`text-xs leading-snug ${tone === "warn" ? "text-destructive" : "text-muted-foreground"}`}>
      {children}
    </span>
  );
}

function ResultAction({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <>
      {" "}
      <button
        type="button"
        onClick={onClick}
        className="font-medium text-foreground underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
      >
        {label}
      </button>
    </>
  );
}
