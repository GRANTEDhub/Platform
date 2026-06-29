"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";

// Analyst QA on a match score. Agree -> logged as agreement. Disagree -> capture
// the corrected score (0-3) + why. Append-only; every response is a datapoint.
export function MatchFeedback({ cardId }: { cardId: string }) {
  const router = useRouter();
  const [mode, setMode] = useState<"idle" | "disagree" | "done">("idle");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [score, setScore] = useState<number | null>(null);
  const [reason, setReason] = useState("");

  async function submit(agree: boolean, corrected?: number) {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/feedback", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          review_card_id: cardId,
          agree,
          corrected_score: corrected,
          reason: agree ? undefined : reason,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Failed to record feedback");
      setMode("done");
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to record feedback");
    } finally {
      setBusy(false);
    }
  }

  if (mode === "done") {
    return <p className="text-sm text-muted-foreground">Feedback recorded — logged for calibration.</p>;
  }

  return (
    <div className="space-y-3">
      <p className="text-sm">Do you agree with this score?</p>
      {mode === "idle" && (
        <div className="flex gap-2">
          <Button size="sm" onClick={() => submit(true)} disabled={busy}>
            Agree
          </Button>
          <Button size="sm" variant="outline" onClick={() => setMode("disagree")} disabled={busy}>
            Disagree
          </Button>
        </div>
      )}
      {mode === "disagree" && (
        <div className="space-y-2">
          <div className="flex items-center gap-2">
            <span className="text-xs text-muted-foreground">Correct score:</span>
            {[0, 1, 2, 3].map((n) => (
              <button
                key={n}
                type="button"
                onClick={() => setScore(n)}
                className={`h-8 w-8 rounded-md border text-sm ${
                  score === n ? "bg-primary text-primary-foreground" : "bg-card hover:bg-accent/60"
                }`}
              >
                {n}
              </button>
            ))}
          </div>
          <textarea
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            rows={3}
            placeholder="Why? What did the engine get wrong (seat, eligibility, fit)?"
            className="flex w-full rounded-md border border-input bg-card px-3 py-2 text-sm"
          />
          <Button
            size="sm"
            onClick={() => {
              if (score === null) {
                setError("Pick a corrected score (0–3).");
                return;
              }
              submit(false, score);
            }}
            disabled={busy}
          >
            Submit feedback
          </Button>
        </div>
      )}
      {error && <p className="text-sm text-destructive">{error}</p>}
    </div>
  );
}
