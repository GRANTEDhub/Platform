"use client";

import { useState } from "react";
import { Check, Loader2, ThumbsDown, ThumbsUp } from "lucide-react";

// "Does this score look right to you?" — the calibration control on the fit-score panel.
//
// THE SCORE IS IMMUTABLE. This trains future scoring and changes nothing about the card in
// front of you, and the caption says so rather than leaving the reviewer to discover it
// by pressing a button and watching nothing happen. There is deliberately no editable
// score field: a number a reviewer can overwrite is a number nobody can calibrate against.
//
// DISAGREE IS NOT A BARE BUTTON, and that asymmetry is the API's, not a design choice.
// POST /api/feedback rejects a disagree with no reason — the reason IS the calibration
// signal, and a thumbs-down with no text teaches the scorer nothing. So agreeing is one
// click and disagreeing opens a line to say why.
//
// Feedback is append-only (match_feedback, migration 0013), so `submitted` is the read of
// whether THIS reviewer has already weighed in; pressing again would stack duplicate rows
// against the same match.

type Phase = "idle" | "reason" | "saving" | "done";

export function ScoreFeedback({
  cardId,
  initial,
}: {
  cardId: string;
  // What this reviewer said last time, or null if they have not. Read on the server so
  // the control does not flash an unanswered state on every visit.
  initial: { agree: boolean } | null;
}) {
  const [phase, setPhase] = useState<Phase>(initial ? "done" : "idle");
  const [agreed, setAgreed] = useState<boolean | null>(initial?.agree ?? null);
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);

  async function send(agree: boolean, why?: string) {
    setPhase("saving");
    setError(null);
    try {
      const res = await fetch("/api/feedback", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ review_card_id: cardId, agree, ...(why ? { reason: why } : {}) }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || "Couldn't save that");
      setAgreed(agree);
      setPhase("done");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't save that");
      setPhase(why === undefined ? "idle" : "reason");
    }
  }

  return (
    <div className="mt-[13px] border-t border-white/[0.14] pt-3">
      {phase === "done" ? (
        <p className="flex items-center gap-2 text-[12px] text-white/[0.75]">
          <Check className="h-3.5 w-3.5 shrink-0" style={{ color: "#4ADE80" }} aria-hidden="true" />
          {agreed ? "You agreed with this score." : "You flagged this score."} Recorded for future scoring.
        </p>
      ) : (
        <>
          <p className="text-[12px] text-white/[0.75]">Does this score look right to you?</p>

          {phase === "reason" ? (
            <div className="mt-[9px]">
              <label className="sr-only" htmlFor={`why-${cardId}`}>
                What is wrong with this score?
              </label>
              <input
                id={`why-${cardId}`}
                autoFocus
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && reason.trim()) void send(false, reason.trim());
                  if (e.key === "Escape") setPhase("idle");
                }}
                placeholder="What did it get wrong?"
                className="h-9 w-full rounded-sharp border border-white/20 bg-white/[0.08] px-2.5 text-[12.5px] text-white outline-none placeholder:text-white/40 focus:border-white/40"
              />
              <div className="mt-2 flex items-center gap-2">
                <button
                  type="button"
                  disabled={!reason.trim()}
                  onClick={() => void send(false, reason.trim())}
                  className="inline-flex h-8 flex-1 items-center justify-center rounded-sharp bg-white text-[12.5px] font-semibold text-brand-navy transition-opacity hover:opacity-90 disabled:opacity-45"
                >
                  Send feedback
                </button>
                <button
                  type="button"
                  onClick={() => setPhase("idle")}
                  className="inline-flex h-8 items-center rounded-sharp border border-white/20 px-3 text-[12.5px] font-medium text-white/[0.85] transition-colors hover:border-white/40"
                >
                  Cancel
                </button>
              </div>
            </div>
          ) : (
            <div className="mt-[9px] flex items-center gap-2">
              <FeedbackButton disabled={phase === "saving"} onClick={() => void send(true)}>
                {phase === "saving" ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
                ) : (
                  <ThumbsUp className="h-3.5 w-3.5" aria-hidden="true" />
                )}
                Agree
              </FeedbackButton>
              <FeedbackButton disabled={phase === "saving"} onClick={() => setPhase("reason")}>
                <ThumbsDown className="h-3.5 w-3.5" aria-hidden="true" />
                Disagree
              </FeedbackButton>
            </div>
          )}

          <p className="mt-2 text-[11px] leading-[1.45] text-white/[0.58]">
            Trains future scoring. The score itself doesn&apos;t change.
          </p>
        </>
      )}
      {error && <p className="mt-2 text-[11px] text-orange-200">{error}</p>}
    </div>
  );
}

function FeedbackButton({
  disabled,
  onClick,
  children,
}: {
  disabled: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className="inline-flex h-[34px] flex-1 items-center justify-center gap-[7px] rounded-sharp border border-white/20 bg-white/10 text-[12.5px] font-semibold text-white transition-colors hover:border-white/40 hover:bg-white/[0.16] disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-orange/60 focus-visible:ring-offset-2 focus-visible:ring-offset-brand-chrome"
    >
      {children}
    </button>
  );
}
