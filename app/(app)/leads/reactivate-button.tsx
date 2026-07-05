"use client";

import { useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { setLeadStage } from "./actions";

// Reactivate a rejected/archived lead back to the entry stage (discovery_pending).
export function ReactivateButton({ leadId }: { leadId: string }) {
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  return (
    <div className="space-y-1 text-sm">
      {error && <p className="text-xs text-destructive">{error}</p>}
      <Button
        type="button"
        size="sm"
        variant="outline"
        disabled={pending}
        onClick={() => {
          setError(null);
          start(async () => {
            try { await setLeadStage(leadId, "discovery_pending"); }
            catch (e) { setError(e instanceof Error ? e.message : "Couldn't reactivate."); }
          });
        }}
      >
        {pending ? "Reactivating…" : "Reactivate lead"}
      </Button>
    </div>
  );
}
