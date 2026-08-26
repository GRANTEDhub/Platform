"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Loader2, RotateCw } from "lucide-react";

// Re-score ONE matched (grant, client) pair on demand. Mounted on TWO staff surfaces from
// the SAME component so their behaviour can't drift — only chrome and the drop-nav differ:
//   - the Ledger's "Matched clients" list  (tone="light", drop -> refresh the list)
//   - the console ScoreCard, beside the feedback controls (tone="dark", drop -> back to the
//     Grant Report, since a drop deletes the card the reviewer is standing on)
// The single-card companion to the grant-level "Re-match clients" (whole roster). See
// app/api/review/[id]/rematch for what the route does and what it refuses.
//
// IT SAYS WHAT IT CAN DO. It runs the full matcher (slow, not free) and, because a re-score
// can drop a card that no longer qualifies, it takes a confirm before it runs.
//
// IT HOLDS A RESULT WORTH READING. A drift (the score moved) or a drop (the card was removed)
// is the whole reason to have run it, so those states show what happened and make the next
// click — reload, or back to the report — the reviewer's own, rather than silently
// re-rendering out from under them. A no-op (unchanged / now pre-filtered) just says so.
//
// STAFF/ADMIN SURFACES ONLY. On the console it rides the default-null `rematch` slot (like
// scoreFactors / feedback), so the client portal never passes it and it never renders there.

type RematchResult =
  | { kind: "refreshed"; storedFitScore: number | null; freshFitScore: number | null; drifted: boolean }
  | { kind: "dropped"; storedFitScore: number | null; reason: string }
  | { kind: "prefiltered"; reason: string }
  | { kind: "error"; detail: string };

type Phase = "idle" | "confirm" | "scoring" | "result";
type Tone = "light" | "dark";

// Per-surface class tokens. `light` is the Ledger's neutral shadcn vocabulary; `dark` is the
// console ScoreCard's white-on-chrome (matching ScoreFeedback) — the footer sits on
// bg-brand-chrome, so muted-foreground would be near-invisible there.
const TONE: Record<Tone, { base: string; hover: string; strong: string; warn: string; ring: string }> = {
  light: {
    base: "text-muted-foreground",
    hover: "hover:text-foreground",
    strong: "text-foreground",
    warn: "text-destructive",
    ring: "focus-visible:ring-ring focus-visible:ring-offset-2",
  },
  dark: {
    base: "text-white/70",
    hover: "hover:text-white",
    strong: "text-white",
    warn: "text-orange-200",
    ring: "focus-visible:ring-brand-orange/60 focus-visible:ring-offset-2 focus-visible:ring-offset-brand-chrome",
  },
};

export function CardRematchButton({
  cardId,
  tone = "light",
  backHref,
}: {
  cardId: string;
  tone?: Tone;
  // When set (the console), a drop navigates here — the card is gone, so the page it was on
  // is a dead end. When absent (the Ledger), a drop just refreshes the list in place.
  backHref?: string;
}) {
  const router = useRouter();
  const [phase, setPhase] = useState<Phase>("idle");
  const [result, setResult] = useState<RematchResult | null>(null);
  const t = TONE[tone];

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

  // Where a drop leaves you: to the report on the console (the card page is now dead), or a
  // list refresh on the Ledger (the row simply disappears).
  const drop = backHref
    ? { label: "Back to the Grant Report", onClick: () => router.push(backHref) }
    : { label: "Refresh", onClick: () => router.refresh() };

  if (phase === "result" && result) {
    if (result.kind === "dropped") {
      return (
        <ResultNote t={t} warn>
          Re-scored and removed — {result.reason}.
          <ResultAction t={t} label={drop.label} onClick={drop.onClick} />
        </ResultNote>
      );
    }
    if (result.kind === "refreshed") {
      const moved =
        result.storedFitScore !== null && result.freshFitScore !== null && result.drifted
          ? `${result.storedFitScore}/3 → ${result.freshFitScore}/3`
          : `still ${result.freshFitScore ?? result.storedFitScore ?? "?"}/3`;
      return (
        <ResultNote t={t}>
          Re-scored — {moved}.
          {result.drifted ? (
            <ResultAction t={t} label="Refresh" onClick={() => router.refresh()} />
          ) : (
            <ResultAction t={t} label="Done" onClick={reset} />
          )}
        </ResultNote>
      );
    }
    if (result.kind === "prefiltered") {
      return (
        <ResultNote t={t}>
          Left unchanged — {result.reason}.
          <ResultAction t={t} label="Done" onClick={reset} />
        </ResultNote>
      );
    }
    return (
      <ResultNote t={t} warn>
        {result.detail}
        <ResultAction t={t} label="Try again" onClick={reset} />
      </ResultNote>
    );
  }

  if (phase === "confirm") {
    return (
      <span className="inline-flex items-center gap-2 text-xs">
        <span className={t.base}>Re-score?</span>
        <button
          type="button"
          onClick={() => void run()}
          className={`font-medium ${t.strong} underline-offset-2 hover:underline focus-visible:outline-none ${t.ring}`}
        >
          Yes
        </button>
        <button
          type="button"
          onClick={() => setPhase("idle")}
          className={`${t.base} ${t.hover} focus-visible:outline-none ${t.ring}`}
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
      className={`inline-flex items-center gap-1.5 text-xs ${t.base} transition-colors ${t.hover} disabled:opacity-60 focus-visible:outline-none ${t.ring}`}
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

function ResultNote({
  t,
  warn = false,
  children,
}: {
  t: (typeof TONE)[Tone];
  warn?: boolean;
  children: React.ReactNode;
}) {
  return <span className={`text-xs leading-snug ${warn ? t.warn : t.base}`}>{children}</span>;
}

function ResultAction({
  t,
  label,
  onClick,
}: {
  t: (typeof TONE)[Tone];
  label: string;
  onClick: () => void;
}) {
  return (
    <>
      {" "}
      <button
        type="button"
        onClick={onClick}
        className={`font-medium ${t.strong} underline-offset-2 hover:underline focus-visible:outline-none ${t.ring}`}
      >
        {label}
      </button>
    </>
  );
}
