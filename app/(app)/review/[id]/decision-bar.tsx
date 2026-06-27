"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import type { CardDecision } from "@/types/database";

export function DecisionBar({
  cardId,
  decision,
  isAdmin,
}: {
  cardId: string;
  decision: CardDecision;
  isAdmin: boolean;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showHold, setShowHold] = useState(false);
  const [holdReason, setHoldReason] = useState("");

  async function decide(next: CardDecision, hold_reason?: string) {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/review/${cardId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ decision: next, hold_reason }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Failed");
      setShowHold(false);
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to update");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-2">
        {isAdmin ? (
          <Button onClick={() => decide("approved")} disabled={busy || decision === "approved"}>
            Approve for client
          </Button>
        ) : (
          <span className="rounded-md border border-dashed px-3 py-2 text-xs text-muted-foreground">
            Final approval is admin-only
          </span>
        )}
        <Button variant="outline" onClick={() => setShowHold((s) => !s)} disabled={busy}>
          Hold
        </Button>
        <Button variant="destructive" onClick={() => decide("passed")} disabled={busy || decision === "passed"}>
          Pass
        </Button>
        {decision !== "pending" && (
          <Button variant="ghost" onClick={() => decide("pending")} disabled={busy}>
            Reset
          </Button>
        )}
      </div>

      {showHold && (
        <div className="space-y-2 rounded-md border bg-card p-3">
          <textarea
            value={holdReason}
            onChange={(e) => setHoldReason(e.target.value)}
            rows={2}
            placeholder="Why hold? (e.g. confirm SAM.gov, awaiting quorum court)"
            className="flex w-full rounded-md border border-input bg-card px-3 py-2 text-sm"
          />
          <Button size="sm" onClick={() => decide("hold", holdReason)} disabled={busy}>
            Save hold
          </Button>
        </div>
      )}

      {error && <p className="text-sm text-destructive">{error}</p>}
    </div>
  );
}
