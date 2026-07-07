"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";

// "Close" a grant for prospecting from the intel pane. One-directional here: the
// grant leaves the prospect pane but stays in the Ledger with history; reopening
// is a future Ledger action. Confirms first since there's no un-close in this view.
export function CloseProspectingButton({ grantId }: { grantId: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function close() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/grants/${grantId}/close-prospecting`, { method: "POST" });
      const d = await res.json();
      if (!res.ok) throw new Error(d.error || "Failed to close");
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to close");
      setBusy(false);
    }
  }

  if (confirming) {
    return (
      <div className="flex items-center gap-2">
        <span className="text-xs text-muted-foreground">Close prospecting? Reopen later from the Ledger.</span>
        <Button size="sm" variant="outline" className="border-destructive/40 text-destructive hover:bg-destructive/5" disabled={busy} onClick={close}>
          {busy ? "Closing…" : "Confirm"}
        </Button>
        <Button size="sm" variant="ghost" disabled={busy} onClick={() => setConfirming(false)}>
          Cancel
        </Button>
        {error && <span className="text-xs text-destructive">{error}</span>}
      </div>
    );
  }

  return (
    <Button size="sm" variant="outline" onClick={() => setConfirming(true)}>
      Close
    </Button>
  );
}
