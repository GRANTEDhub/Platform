"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";

// On-demand "Generate report" trigger for the client/prospect dashboard -- the
// client->pool mirror of the grant->roster RematchButton. POSTs to
// /api/clients/[id]/generate-report, which flips the record to 'queued' and kicks
// drainClientMatchQueue; the dashboard's in-progress banner + AutoRefresh then poll
// to completion. No matching logic here.
//
// Cost guard, three layers (all required, per Build A scope):
//   1. disable-on-submit (`busy`) -- closes the sub-second double-click race, the
//      real 2x-LLM-spend hole (a second click landing before the first response).
//   2. disabled while in progress (`inProgress` = queued/running) -- no re-fire
//      while a run is already live.
//   3. confirm-before-rerun (`confirmRerun`) -- when the record already has results,
//      a confirm guards an accidental re-click AND sets the expectation that the
//      current results briefly show a "refreshing" state while re-scoring.
export function GenerateReportButton({
  clientId,
  inProgress,
  confirmRerun,
}: {
  clientId: string;
  inProgress: boolean;
  confirmRerun: boolean;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function run() {
    if (busy || inProgress) return; // layers 1 + 2
    if (
      confirmRerun &&
      !window.confirm(
        "Re-run matching for this record against the current grant pool?\n\n" +
          "Only grants added since the last run are scored — existing matches aren't re-scored. " +
          "The current results stay visible under a “refreshing” state until it finishes.",
      )
    ) {
      return; // layer 3
    }
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/clients/${clientId}/generate-report`, { method: "POST" });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || "Couldn't start matching.");
      router.refresh(); // re-render into the in-progress banner; AutoRefresh takes over
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't start matching.");
    } finally {
      setBusy(false);
    }
  }

  const disabled = busy || inProgress;
  return (
    <div className="flex flex-col items-end gap-1">
      <Button variant="outline" size="sm" onClick={run} disabled={disabled}>
        <RefreshCw className={`h-3.5 w-3.5 ${disabled ? "animate-spin" : ""}`} />
        {inProgress ? "Matching…" : busy ? "Starting…" : "Generate report"}
      </Button>
      {error && <p className="text-xs text-destructive">{error}</p>}
    </div>
  );
}
