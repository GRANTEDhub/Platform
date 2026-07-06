"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { DecisionConfirmation } from "./decision-confirmation";
import type { CardDecision } from "@/types/database";
import type { GrantSummary } from "@/app/api/review/[id]/route";

type DecidePayload = {
  decision_reason?: string;
  final_outreach_email?: string;
  final_to?: string;
  final_subject?: string;
};

// The decision panel that lives at the top of the review sidebar, pinned so it
// stays visible on a long grant (sticky within the sidebar column). Two clusters:
//   - Score feedback on Argo's 1-3 fit score, independent of the decision. Agree
//     logs a silent confirm; Flag captures WHY we disagree -> match_feedback
//     calibration dataset (POST /api/feedback).
//   - The decision: Send (reuses the existing modal + PATCH /api/review send flow)
//     and Reject (reason). Admin-gated to mirror the API.
export function DecisionPanel({
  cardId,
  decision,
  isAdmin,
  draft,
  finalEmail,
  recipientEmail,
  defaultSubject,
}: {
  cardId: string;
  decision: CardDecision;
  isAdmin: boolean;
  draft: string;
  finalEmail: string | null;
  recipientEmail: string | null;
  defaultSubject: string;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [panel, setPanel] = useState<null | "send" | "reject" | "flag">(null);
  const [confirm, setConfirm] = useState<GrantSummary | null>(null);

  const [to, setTo] = useState(recipientEmail ?? "");
  const [subject, setSubject] = useState(defaultSubject);
  const [body, setBody] = useState(finalEmail ?? draft);
  const [rejectReason, setRejectReason] = useState("");

  const [fb, setFb] = useState<"idle" | "agreed" | "flagged">("idle");
  const [flagReason, setFlagReason] = useState("");

  async function decide(next: CardDecision, payload?: DecidePayload) {
    setBusy(true);
    setError(null);
    setStatus(null);
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
      setStatus(data.send_status ?? null);
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

  function openSend() {
    setTo(recipientEmail ?? "");
    setSubject(defaultSubject);
    setBody(finalEmail ?? draft);
    setError(null);
    setPanel("send");
  }

  if (confirm) return <DecisionConfirmation summary={confirm} />;

  return (
    <div className="sticky top-6 rounded-2xl border border-brand-navy/10 bg-white p-4">
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

      {/* Decision */}
      {isAdmin ? (
        <Button className="w-full" disabled={busy} onClick={openSend}>
          Send
        </Button>
      ) : (
        <p className="rounded-md border border-dashed px-3 py-2 text-xs text-muted-foreground">
          Final approval is admin-only. You can reject a match for review.
        </p>
      )}
      <Button
        variant="outline"
        className="mt-2 w-full border-destructive/40 text-destructive hover:bg-destructive/5"
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
      {status && <p className="mt-2.5 text-xs text-muted-foreground">{status}</p>}

      {/* Send modal (reused verbatim from the prior send flow). */}
      {panel === "send" && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
          onClick={() => !busy && setPanel(null)}
        >
          <div
            className="max-h-[90vh] w-full max-w-2xl overflow-y-auto rounded-xl border bg-card p-5 shadow-xl"
            onClick={(e) => e.stopPropagation()}
          >
            <h2 className="font-serif text-lg font-semibold text-brand-navy">Send outreach</h2>
            <p className="mt-1 text-xs text-muted-foreground">
              Review the email below. Edit any field, then send — or send as-is.
            </p>
            <div className="mt-4 space-y-3">
              <label className="block space-y-1">
                <span className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">To</span>
                <input type="email" value={to} onChange={(e) => setTo(e.target.value)} placeholder="name@org.org"
                  className="flex h-9 w-full rounded-md border border-input bg-card px-3 text-sm" />
              </label>
              <label className="block space-y-1">
                <span className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">Subject</span>
                <input value={subject} onChange={(e) => setSubject(e.target.value)}
                  className="flex h-9 w-full rounded-md border border-input bg-card px-3 text-sm" />
              </label>
              <label className="block space-y-1">
                <span className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">Body</span>
                <textarea value={body} onChange={(e) => setBody(e.target.value)} rows={14}
                  className="flex w-full rounded-md border border-input bg-card px-3 py-2 font-sans text-sm" />
              </label>
            </div>
            {error && <p className="mt-3 text-sm text-destructive">{error}</p>}
            <div className="mt-4 flex justify-end gap-2">
              <Button variant="ghost" onClick={() => setPanel(null)} disabled={busy}>Cancel</Button>
              <Button
                onClick={() => decide("approved", { final_outreach_email: body, final_to: to, final_subject: subject })}
                disabled={busy || !body.trim() || !to.trim()}
              >
                {busy ? "Sending…" : "Send email"}
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
