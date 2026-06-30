"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";

// Fires Track 2 discovery for one grant. Synchronous server call (Brave search +
// extraction + scoring), so it shows a busy state, then refreshes to surface the
// prospect cards the run wrote. Degrades to the failure reason if search is
// blocked/unconfigured.
export function ProspectButton({ grantId }: { grantId: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function run() {
    setBusy(true);
    setError(null);
    setStatus(null);
    try {
      const res = await fetch(`/api/grants/${grantId}/prospect`, { method: "POST" });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Discovery failed");
      setStatus(
        data.carded > 0
          ? `${data.carded} prospect${data.carded === 1 ? "" : "s"} surfaced (from ${data.grounded} grounded candidate${data.grounded === 1 ? "" : "s"}).`
          : `No qualifying prospects found (${data.candidates ?? 0} candidate${data.candidates === 1 ? "" : "s"} considered).`,
      );
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Discovery failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="shrink-0 text-right">
      <Button size="sm" onClick={run} disabled={busy}>
        {busy ? "Searching…" : "Prospect"}
      </Button>
      {status && <p className="mt-1 max-w-xs text-xs text-muted-foreground">{status}</p>}
      {error && <p className="mt-1 max-w-xs text-xs text-destructive">{error}</p>}
    </div>
  );
}
