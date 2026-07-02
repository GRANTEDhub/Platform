"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";

// Manual "Add to Client": pick an active client, Add, and the server scores the
// (grant, client) pair on demand and creates a card. Low fit is surfaced but
// added anyway; eligibility-constraint blocks come back as an error message that
// says it's a constraint, not a fit score.
type ClientOption = { id: string; name: string };

export function AddToClientControl({
  grantId,
  clients,
}: {
  grantId: string;
  clients: ClientOption[];
}) {
  const router = useRouter();
  const [clientId, setClientId] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ kind: "success" | "error"; text: string } | null>(null);

  async function add() {
    if (!clientId) return;
    setBusy(true);
    setMessage(null);
    try {
      const res = await fetch(`/api/grants/${grantId}/add-client`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ clientId }),
      });
      const data = await res.json();
      if (!res.ok) {
        setMessage({ kind: "error", text: data.error || "Failed to add." });
        return;
      }
      setMessage({ kind: "success", text: `Added — engine fit ${data.fit_score}/3.` });
      setClientId("");
      router.refresh();
    } catch {
      setMessage({ kind: "error", text: "Failed to add." });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2">
        <select
          value={clientId}
          onChange={(e) => setClientId(e.target.value)}
          disabled={busy}
          className="h-9 flex-1 rounded-md border border-input bg-card px-2 text-sm"
        >
          <option value="">Select a client…</option>
          {clients.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </select>
        <Button size="sm" onClick={add} disabled={busy || !clientId}>
          {busy ? "Adding…" : "Add"}
        </Button>
      </div>
      {message && (
        <p className={`text-xs ${message.kind === "error" ? "text-destructive" : "text-muted-foreground"}`}>
          {message.text}
        </p>
      )}
    </div>
  );
}
