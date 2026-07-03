"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";

// Promotes a scored Track-2 prospect into a tracked lead carrying its grant-match
// context (P2.5), then surfaces the outcome. For lead outcomes it returns a
// lead-bound scheduling link to paste into the (manual, for now) warm email.
type Result =
  | { outcome: "lead_created"; leadName: string; url: string | null }
  | { outcome: "attached_to_lead"; leadName: string; url: string | null }
  | { outcome: "routed_to_client"; clientName: string };

export function StartOutreachButton({
  prospectId,
  grantId,
}: {
  prospectId: string;
  grantId: string;
}) {
  const [result, setResult] = useState<Result | null>(null);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function start() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/prospects/${prospectId}/start-outreach`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ grantId }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Failed");
      setResult(data as Result);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed");
    } finally {
      setBusy(false);
    }
  }

  async function copy(url: string) {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      setError("Copy failed — select and copy manually.");
    }
  }

  if (!result) {
    return (
      <div>
        <Button variant="outline" size="sm" onClick={start} disabled={busy}>
          {busy ? "Starting…" : "Start outreach"}
        </Button>
        {error && <p className="mt-1 text-xs text-destructive">{error}</p>}
      </div>
    );
  }

  if (result.outcome === "routed_to_client") {
    return (
      <p className="text-xs text-muted-foreground">
        {result.clientName} is already a client — routed to their account manager to pursue.
      </p>
    );
  }

  const verb = result.outcome === "lead_created" ? "Lead created" : "Attached to existing lead";
  return (
    <div className="space-y-1">
      <p className="text-xs text-muted-foreground">
        {verb}: <span className="font-medium text-foreground">{result.leadName}</span>
      </p>
      {result.url && (
        <div className="flex items-center gap-2">
          <input
            readOnly
            value={result.url}
            onFocus={(e) => e.currentTarget.select()}
            className="w-56 rounded-md border border-input bg-muted/40 px-2 py-1 text-xs"
          />
          <Button variant="outline" size="sm" onClick={() => copy(result.url!)}>
            {copied ? "Copied" : "Copy link"}
          </Button>
        </div>
      )}
    </div>
  );
}
