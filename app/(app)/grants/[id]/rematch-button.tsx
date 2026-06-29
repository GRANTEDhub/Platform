"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";

export function RematchButton({ grantId }: { grantId: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState<null | "rematch" | "reshred">(null);
  const [error, setError] = useState<string | null>(null);

  async function run(reshred: boolean) {
    setBusy(reshred ? "reshred" : "rematch");
    setError(null);
    try {
      const res = await fetch(`/api/grants/${grantId}/rematch`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reshred }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Failed");
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed");
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="space-y-1">
      <div className="flex flex-wrap gap-2">
        <Button variant="outline" onClick={() => run(false)} disabled={busy !== null}>
          {busy === "rematch" ? "Re-matching…" : "Re-match clients"}
        </Button>
        <Button variant="outline" onClick={() => run(true)} disabled={busy !== null}>
          {busy === "reshred" ? "Re-shredding…" : "Re-shred (rebuild profile)"}
        </Button>
      </div>
      <p className="text-xs text-muted-foreground">
        Re-match: re-score clients against the stored shred (fast). Re-shred: re-fetch
        the NOFO and rebuild the profile, then re-score (slower).
      </p>
      {error && <p className="text-xs text-destructive">{error}</p>}
    </div>
  );
}
