"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";

// Mints a tokenized outbound-door scheduling link for a (prospect, grant) and
// surfaces it for the analyst to copy into an outreach email (manual send for
// now). Each generate mints a fresh token; prior links stay valid until expiry.
export function ScheduleLinkButton({
  prospectId,
  grantId,
}: {
  prospectId: string;
  grantId: string;
}) {
  const [url, setUrl] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function generate() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/prospects/${prospectId}/schedule-link`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ grantId }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Failed");
      setUrl(data.url);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed");
    } finally {
      setBusy(false);
    }
  }

  async function copy() {
    if (!url) return;
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      setError("Copy failed — select and copy manually.");
    }
  }

  if (!url) {
    return (
      <div>
        <Button variant="ghost" size="sm" onClick={generate} disabled={busy}>
          {busy ? "Generating…" : "Scheduling link"}
        </Button>
        {error && <p className="mt-1 text-xs text-destructive">{error}</p>}
      </div>
    );
  }

  return (
    <div className="flex items-center gap-2">
      <input
        readOnly
        value={url}
        onFocus={(e) => e.currentTarget.select()}
        className="w-56 rounded-md border border-input bg-muted/40 px-2 py-1 text-xs"
      />
      <Button variant="outline" size="sm" onClick={copy}>
        {copied ? "Copied" : "Copy"}
      </Button>
    </div>
  );
}
