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

// The match decision. Admins get two actions: Reject and Send. Send opens a modal
// (recipient / subject / body, editable in place) that surfaces the outreach draft
// on demand -- it is not shown before the admin chooses to send. Sending funnels
// through the same decide("approved", {...}) path as before, so the API's
// send-guard + grant_summary/confirmation flow is unchanged. Reset stays secondary.
export function DecisionBar({
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
  const [panel, setPanel] = useState<null | "send" | "reject">(null);
  const [rejectReason, setRejectReason] = useState("");
  const [confirm, setConfirm] = useState<GrantSummary | null>(null);

  // Modal fields, seeded when the modal opens. Body prefers an already-approved
  // final email, else the engine draft.
  const [to, setTo] = useState(recipientEmail ?? "");
  const [subject, setSubject] = useState(defaultSubject);
  const [body, setBody] = useState(finalEmail ?? draft);

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
      // Client-card terminal decisions return grant_summary -> the confirmation
      // overlay takes over (it owns navigation). Prospect cards and Reset return
      // no summary and keep the inline status + refresh behavior.
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

  function openSend() {
    // Reseed each open so the modal reflects the latest saved values.
    setTo(recipientEmail ?? "");
    setSubject(defaultSubject);
    setBody(finalEmail ?? draft);
    setError(null);
    setPanel("send");
  }

  if (confirm) return <DecisionConfirmation summary={confirm} />;

  return (
    <div className="space-y-3">
      {isAdmin ? (
        <div className="flex flex-col gap-2">
          <Button onClick={openSend} disabled={busy}>
            Send
          </Button>
          <Button
            variant="destructive"
            onClick={() => setPanel((p) => (p === "reject" ? null : "reject"))}
            disabled={busy}
          >
            Reject
          </Button>
        </div>
      ) : (
        <span className="block rounded-md border border-dashed px-3 py-2 text-xs text-muted-foreground">
          Final approval is admin-only. You can reject a match for review.
        </span>
      )}

      <div className="flex flex-wrap gap-2">
        {!isAdmin && (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setPanel((p) => (p === "reject" ? null : "reject"))}
            disabled={busy}
          >
            Reject
          </Button>
        )}
        {decision !== "pending" && (
          <Button variant="ghost" size="sm" onClick={() => decide("pending")} disabled={busy}>
            Reset
          </Button>
        )}
      </div>

      {panel === "reject" && (
        <div className="space-y-2 rounded-md border bg-card p-3">
          <textarea
            value={rejectReason}
            onChange={(e) => setRejectReason(e.target.value)}
            rows={3}
            placeholder="Why reject? (e.g. wrong entity type, no realistic prime path)"
            className="flex w-full rounded-md border border-input bg-card px-3 py-2 text-sm"
          />
          <Button
            size="sm"
            variant="destructive"
            onClick={() => decide("passed", { decision_reason: rejectReason })}
            disabled={busy}
          >
            Reject match
          </Button>
        </div>
      )}

      {error && !panel && <p className="text-sm text-destructive">{error}</p>}
      {status && <p className="text-sm text-muted-foreground">{status}</p>}

      {/* Send modal: scrim dims the page; the panel holds the editable email. */}
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
                <input
                  type="email"
                  value={to}
                  onChange={(e) => setTo(e.target.value)}
                  placeholder="name@org.org"
                  className="flex h-9 w-full rounded-md border border-input bg-card px-3 text-sm"
                />
              </label>
              <label className="block space-y-1">
                <span className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">Subject</span>
                <input
                  value={subject}
                  onChange={(e) => setSubject(e.target.value)}
                  className="flex h-9 w-full rounded-md border border-input bg-card px-3 text-sm"
                />
              </label>
              <label className="block space-y-1">
                <span className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">Body</span>
                <textarea
                  value={body}
                  onChange={(e) => setBody(e.target.value)}
                  rows={14}
                  className="flex w-full rounded-md border border-input bg-card px-3 py-2 font-sans text-sm"
                />
              </label>
            </div>

            {error && <p className="mt-3 text-sm text-destructive">{error}</p>}

            <div className="mt-4 flex justify-end gap-2">
              <Button variant="ghost" onClick={() => setPanel(null)} disabled={busy}>
                Cancel
              </Button>
              <Button
                onClick={() =>
                  decide("approved", {
                    final_outreach_email: body,
                    final_to: to,
                    final_subject: subject,
                  })
                }
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
