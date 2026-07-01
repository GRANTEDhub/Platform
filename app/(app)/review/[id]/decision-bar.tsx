"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import type { CardDecision } from "@/types/database";

type DecidePayload = {
  decision_reason?: string;
  final_outreach_email?: string;
};

// The three-way match decision. Admins get Approve & Send / Edit & Send /
// Reject; Reset stays as a secondary control. On approval the API
// attempts a send behind the preview/prod guard and returns send_status, which
// is surfaced below so a "recorded but not sent" outcome is never silent.
export function DecisionBar({
  cardId,
  decision,
  isAdmin,
  draft,
  finalEmail,
}: {
  cardId: string;
  decision: CardDecision;
  isAdmin: boolean;
  draft: string;
  finalEmail: string | null;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [panel, setPanel] = useState<null | "edit" | "reject">(null);
  const [editBody, setEditBody] = useState(finalEmail ?? draft);
  const [rejectReason, setRejectReason] = useState("");

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
      setStatus(data.send_status ?? null);
      setPanel(null);
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to update");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-3">
      {isAdmin ? (
        <div className="flex flex-col gap-2">
          {/* Approve & send as-is: copy the AI draft into the final body. */}
          <Button
            onClick={() => decide("approved", { final_outreach_email: draft })}
            disabled={busy}
          >
            Approve &amp; Send
          </Button>
          <Button
            variant="outline"
            onClick={() => setPanel((p) => (p === "edit" ? null : "edit"))}
            disabled={busy}
          >
            Edit &amp; Send
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

      {panel === "edit" && (
        <div className="space-y-2 rounded-md border bg-card p-3">
          <p className="text-xs text-muted-foreground">
            Edit the email, then approve &amp; send.
          </p>
          <textarea
            value={editBody}
            onChange={(e) => setEditBody(e.target.value)}
            rows={12}
            className="flex w-full rounded-md border border-input bg-card px-3 py-2 font-sans text-sm"
          />
          <Button
            size="sm"
            onClick={() => decide("approved", { final_outreach_email: editBody })}
            disabled={busy}
          >
            Approve &amp; Send edited
          </Button>
        </div>
      )}

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

      {error && <p className="text-sm text-destructive">{error}</p>}
      {status && <p className="text-sm text-muted-foreground">{status}</p>}
    </div>
  );
}
