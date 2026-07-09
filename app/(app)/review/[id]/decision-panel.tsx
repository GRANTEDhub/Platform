"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { DecisionConfirmation } from "./decision-confirmation";
import type { CardDecision } from "@/types/database";
import type { GrantSummary } from "@/app/api/review/[id]/route";

type DecidePayload = { decision_reason?: string };

// The decision panel at the top of the review sidebar (sticky on a long grant).
// Two clusters:
//   - Score feedback on Argo's 1-3 fit score, independent of the decision. Agree
//     logs a silent confirm; Flag captures WHY we disagree -> match_feedback
//     calibration dataset (POST /api/feedback).
//   - The decision controls. The primary action is `alertSend` (the "Send grant
//     alert" button, passed in for admin client cards) which sits ABOVE Reject.
//     Sending the alert is also the card's approval (handled in the alert route),
//     so there is no separate plain-text Send here anymore. Reject records a
//     'passed' decision; Reset returns to pending.
export function DecisionPanel({
  cardId,
  decision,
  isAdmin,
  alertSend,
}: {
  cardId: string;
  decision: CardDecision;
  isAdmin: boolean;
  alertSend?: React.ReactNode;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [panel, setPanel] = useState<null | "reject" | "flag">(null);
  const [confirm, setConfirm] = useState<GrantSummary | null>(null);
  const [rejectReason, setRejectReason] = useState("");

  const [fb, setFb] = useState<"idle" | "agreed" | "flagged">("idle");
  const [flagReason, setFlagReason] = useState("");

  async function decide(next: CardDecision, payload?: DecidePayload) {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/review/${cardId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ decision: next, ...payload }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Failed");
      if (data.grant_summary) {
        setConfirm(data.grant_summary as GrantSummary);
        return;
      }
      setPanel(null);
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to update");
    } finally {
      setBusy(false);
    }
  }

  async function sendFeedback(agree: boolean, reason?: string) {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/feedback", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ review_card_id: cardId, agree, reason: agree ? undefined : reason }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Failed to record feedback");
      setFb(agree ? "agreed" : "flagged");
      setPanel(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to record feedback");
    } finally {
      setBusy(false);
    }
  }

  if (confirm) return <DecisionConfirmation summary={confirm} />;

  return (
    <div className="rounded-2xl bg-white p-5 shadow-soft">
      {/* Score feedback */}
      <p className="text-[11px] font-semibold uppercase tracking-[0.05em] text-muted-foreground">
        Agree with the score?
      </p>
      {fb === "idle" ? (
        <div className="mt-2.5 flex gap-2">
          <Button variant="outline" size="sm" className="flex-1" disabled={busy} onClick={() => sendFeedback(true)}>
            👍 Agree
          </Button>
          <Button
            variant="outline"
            size="sm"
            className="flex-1"
            disabled={busy}
            onClick={() => setPanel((p) => (p === "flag" ? null : "flag"))}
          >
            👎 Flag
          </Button>
        </div>
      ) : (
        <p className="mt-2 text-xs text-muted-foreground">
          {fb === "agreed" ? "Score confirmed — logged." : "Flagged — logged for calibration."}
        </p>
      )}

      {panel === "flag" && (
        <div className="mt-2.5 space-y-2 rounded-md border border-brand-navy/10 bg-brand-cream/60 p-2.5">
          <p className="text-xs font-medium text-brand-navy">Why do you disagree with the score?</p>
          <textarea
            value={flagReason}
            onChange={(e) => setFlagReason(e.target.value)}
            rows={3}
            autoFocus
            placeholder="What did the engine get wrong — eligibility, role, fit?"
            className="flex w-full rounded-md border border-input bg-card px-2.5 py-1.5 text-sm"
          />
          <Button size="sm" className="w-full" disabled={busy || !flagReason.trim()} onClick={() => sendFeedback(false, flagReason)}>
            Submit flag
          </Button>
        </div>
      )}

      <div className="my-3.5 h-px bg-brand-navy/10" />

      {/* Decision. The primary action is "Send grant alert" (client cards) which
          also approves the card; it sits above Reject with the other controls.
          Prospect cards get no send here -- prospect outreach lives in the lead
          pipeline. */}
      {alertSend}
      {!isAdmin && (
        <p className="rounded-md border border-dashed px-3 py-2 text-xs text-muted-foreground">
          Final approval is admin-only. You can reject a match for review.
        </p>
      )}
      <Button
        variant="outline"
        className={`w-full border-destructive/40 text-destructive hover:bg-destructive/5 ${alertSend || !isAdmin ? "mt-2" : ""}`}
        disabled={busy}
        onClick={() => setPanel((p) => (p === "reject" ? null : "reject"))}
      >
        Reject
      </Button>
      {decision !== "pending" && (
        <Button variant="ghost" size="sm" className="mt-2 w-full" disabled={busy} onClick={() => decide("pending")}>
          Reset decision
        </Button>
      )}

      {panel === "reject" && (
        <div className="mt-2.5 space-y-2 rounded-md border border-brand-navy/10 bg-card p-2.5">
          <textarea
            value={rejectReason}
            onChange={(e) => setRejectReason(e.target.value)}
            rows={3}
            autoFocus
            placeholder="Why reject? (e.g. wrong entity type, no realistic prime path)"
            className="flex w-full rounded-md border border-input bg-card px-2.5 py-1.5 text-sm"
          />
          <Button
            size="sm"
            variant="outline"
            className="w-full border-destructive/40 text-destructive hover:bg-destructive/5"
            disabled={busy}
            onClick={() => decide("passed", { decision_reason: rejectReason })}
          >
            Reject match
          </Button>
        </div>
      )}

      {error && !panel && <p className="mt-2.5 text-sm text-destructive">{error}</p>}
    </div>
  );
}
