"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { DecisionConfirmation } from "./decision-confirmation";
import type { CardDecision } from "@/types/database";
import type { GrantSummary } from "@/app/api/review/[id]/route";

// The persistent decision dock: a sticky bar pinned to the bottom of the review
// column, visible on BOTH tabs (it lives outside the tab content). Two clusters:
//
//   Left  — score feedback on Argo's 1-3 fit score, independent of the decision.
//           Agree = silent logged confirm. Flag = capture WHY we disagree; the
//           reason feeds the match_feedback calibration dataset (POST /api/feedback).
//   Right — the decision: Reject (reason) + Send. Send reuses the existing modal
//           flow (recipient/subject/body, allowlist-gated) via PATCH /api/review.
//
// Reason capture (reject/flag) opens UPWARD as a popover so nothing falls below
// the viewport; Send opens a centered modal. Admin gate mirrors the API: only
// admins see Send; contractors can Reject and give feedback.
export function DecisionDock({
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

  // Send-modal fields, seeded when it opens.
  const [to, setTo] = useState(recipientEmail ?? "");
  const [subject, setSubject] = useState(defaultSubject);
  const [body, setBody] = useState(finalEmail ?? draft);
  const [rejectReason, setRejectReason] = useState("");

  // Score-feedback state (separate from the decision).
  const [fb, setFb] = useState<"idle" | "agreed" | "flagged">("idle");
  const [flagReason, setFlagReason] = useState("");

  async function decide(next: CardDecision, payload?: { decision_reason?: string; final_outreach_email?: string; final_to?: string; final_subject?: string }) {
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
      // Terminal decision on a client card returns grant_summary -> the
      // confirmation overlay takes over (it owns navigation).
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
    <div className="sticky bottom-5 z-40">
      <div className="relative flex flex-wrap items-center justify-between gap-x-4 gap-y-3 rounded-2xl border border-brand-navy/10 bg-white px-4 py-3 shadow-[0_8px_28px_rgba(11,30,58,0.16)]">
        {/* Left: score feedback */}
        <div className="flex items-center gap-2.5">
          {fb === "idle" ? (
            <>
              <span className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                Agree with the score?
              </span>
              <Button size="sm" variant="outline" disabled={busy} onClick={() => sendFeedback(true)}>
                Agree
              </Button>
              <Button
                size="sm"
                variant="outline"
                disabled={busy}
                onClick={() => setPanel((p) => (p === "flag" ? null : "flag"))}
              >
                Flag
              </Button>
            </>
          ) : (
            <span className="text-xs text-muted-foreground">
              {fb === "agreed" ? "Score confirmed — logged." : "Flagged — logged for calibration."}
            </span>
          )}
        </div>

        {/* Right: the decision */}
        <div className="flex items-center gap-2.5">
          {status && <span className="hidden max-w-[280px] truncate text-xs text-muted-foreground sm:inline">{status}</span>}
          {decision !== "pending" && (
            <Button size="sm" variant="ghost" disabled={busy} onClick={() => decide("pending")}>
              Reset
            </Button>
          )}
          <span className="h-7 w-px bg-brand-navy/10" />
          <Button
            size="sm"
            variant="outline"
            className="border-destructive/40 text-destructive hover:bg-destructive/5"
            disabled={busy}
            onClick={() => setPanel((p) => (p === "reject" ? null : "reject"))}
          >
            Reject
          </Button>
          {isAdmin && (
            <Button size="sm" disabled={busy} onClick={openSend}>
              Send
            </Button>
          )}
        </div>

        {error && !panel && (
          <p className="w-full text-right text-xs text-destructive">{error}</p>
        )}

        {/* Flag reason — opens upward */}
        {panel === "flag" && (
          <Popover onClose={() => setPanel(null)} align="left">
            <p className="text-xs font-medium text-brand-navy">Why do you disagree with the score?</p>
            <textarea
              value={flagReason}
              onChange={(e) => setFlagReason(e.target.value)}
              rows={3}
              autoFocus
              placeholder="What did the engine get wrong — eligibility, seat/role, fit?"
              className="mt-2 flex w-full rounded-md border border-input bg-card px-3 py-2 text-sm"
            />
            <div className="mt-2 flex justify-end">
              <Button
                size="sm"
                disabled={busy || !flagReason.trim()}
                onClick={() => sendFeedback(false, flagReason)}
              >
                Submit flag
              </Button>
            </div>
          </Popover>
        )}

        {/* Reject reason — opens upward */}
        {panel === "reject" && (
          <Popover onClose={() => setPanel(null)} align="right">
            <p className="text-xs font-medium text-brand-navy">Reject this match</p>
            <textarea
              value={rejectReason}
              onChange={(e) => setRejectReason(e.target.value)}
              rows={3}
              autoFocus
              placeholder="Why reject? (e.g. wrong entity type, no realistic prime path)"
              className="mt-2 flex w-full rounded-md border border-input bg-card px-3 py-2 text-sm"
            />
            <div className="mt-2 flex justify-end">
              <Button
                size="sm"
                variant="outline"
                className="border-destructive/40 text-destructive hover:bg-destructive/5"
                disabled={busy}
                onClick={() => decide("passed", { decision_reason: rejectReason })}
              >
                Reject match
              </Button>
            </div>
          </Popover>
        )}
      </div>

      {/* Send modal */}
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

// Small popover anchored above the dock (reason capture). align picks which edge
// it hugs so the flag popover sits over the left cluster, reject over the right.
function Popover({
  children,
  onClose,
  align,
}: {
  children: React.ReactNode;
  onClose: () => void;
  align: "left" | "right";
}) {
  return (
    <div
      className={`absolute bottom-full mb-2 w-[min(360px,90vw)] rounded-xl border border-brand-navy/10 bg-white p-3 shadow-[0_8px_28px_rgba(11,30,58,0.16)] ${
        align === "left" ? "left-2" : "right-2"
      }`}
    >
      <button
        type="button"
        onClick={onClose}
        aria-label="Close"
        className="absolute right-2 top-2 text-xs text-muted-foreground hover:text-brand-navy"
      >
        ✕
      </button>
      {children}
    </div>
  );
}
