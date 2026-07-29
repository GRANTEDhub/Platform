"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { SectionLabel } from "@/components/ui/section-label";
import { DecisionConfirmation } from "./decision-confirmation";
import type { CardDecision } from "@/types/database";
import type { GrantSummary } from "@/app/api/review/[id]/route";

type DecidePayload = { decision_reason?: string };

// The decision panel at the top of the review sidebar (sticky on a long grant).
// The primary action is `alertSend` (the "Send grant alert" button, passed in for
// admin client cards) which sits above Reject. Sending the alert is also the card's
// approval (handled in the alert route), so there is no separate plain-text Send
// here. Reject records a 'passed' decision AND requires a reason -- that reason is
// the calibration signal, routed to match_feedback server-side (replacing the old
// standalone agree/flag control). Reset returns to pending.
export function DecisionPanel({
  cardId,
  decision,
  isAdmin,
  alertSend,
  variant = "full",
  bare = false,
  className,
}: {
  cardId: string;
  decision: CardDecision;
  isAdmin: boolean;
  alertSend?: React.ReactNode;
  // "decision" = the "Your call" top-strip layout (label + centered group).
  // "full" (default) = the same controls without that wrapper.
  variant?: "full" | "decision";
  // Drop the white card wrapper so the cluster can sit INSIDE another card.
  bare?: boolean;
  // Extra classes on the root (e.g. `flex-1` to fill the top-strip column height).
  className?: string;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [panel, setPanel] = useState<null | "reject">(null);
  const [confirm, setConfirm] = useState<GrantSummary | null>(null);
  const [rejectReason, setRejectReason] = useState("");

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

  if (confirm) return <DecisionConfirmation summary={confirm} />;

  return (
    <div className={`${bare ? "" : "rounded-2xl bg-white p-5 shadow-soft"}${variant === "decision" ? " flex flex-col" : ""}${className ? ` ${className}` : ""}`}>
      {/* Top-strip "Your call" box: label at top, the Send/Reject group centered
          in the remaining height so a banner-matched box reads composed -- not
          buttons pinned to the top with dead space below. */}
      {variant === "decision" && <SectionLabel>Your call</SectionLabel>}
      <div className={variant === "decision" ? "flex flex-1 flex-col justify-center gap-2" : ""}>
        {/* Primary action is "Send grant alert" (client cards) which also approves
            the card; it sits above Reject. Prospect cards get no send here. */}
        {alertSend}
        {!isAdmin && (
          <p className="rounded-md border border-dashed px-3 py-2 text-xs text-muted-foreground">
            Final approval is admin-only. You can reject a match for review.
          </p>
        )}
        <Button
          variant="outline"
          className={`w-full border-destructive/40 text-destructive hover:bg-destructive/5 ${variant !== "decision" && (alertSend || !isAdmin) ? "mt-2" : ""}`}
          disabled={busy}
          onClick={() => setPanel((p) => (p === "reject" ? null : "reject"))}
        >
          Reject
        </Button>
        {decision !== "pending" && (
          <Button variant="ghost" size="sm" className={`w-full ${variant === "decision" ? "" : "mt-2"}`} disabled={busy} onClick={() => decide("pending")}>
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
            {/* Reason required -- it's the match calibration signal now, routed to
                match_feedback server-side (this replaced the old agree/flag control). */}
            <Button
              size="sm"
              variant="outline"
              className="w-full border-destructive/40 text-destructive hover:bg-destructive/5"
              disabled={busy || !rejectReason.trim()}
              onClick={() => decide("passed", { decision_reason: rejectReason.trim() })}
            >
              Reject match
            </Button>
          </div>
        )}
      </div>

      {error && !panel && <p className="mt-2.5 text-sm text-destructive">{error}</p>}
    </div>
  );
}
