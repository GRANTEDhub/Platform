"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";

export function RematchButton({ grantId }: { grantId: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function rematch() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/grants/${grantId}/rematch`, { method: "POST" });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Re-match failed");
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Re-match failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-1">
      <Button variant="outline" onClick={rematch} disabled={busy}>
        {busy ? "Re-matching…" : "Re-match clients"}
      </Button>
      {error && <p className="text-xs text-destructive">{error}</p>}
    </div>
  );
}
