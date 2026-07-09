"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";

// Contact-email input for a PROSPECT review card. Prospects have no contact on
// discovery; an admin sets one here so the grant-alert one-pager can be emailed
// (which also promotes the prospect into a tracked lead). Persisted via
// PATCH /api/prospects/[id]; the send modal prefills its "To" from this.
export function ProspectContact({
  prospectId,
  initialEmail,
  initialName,
}: {
  prospectId: string;
  initialEmail: string | null;
  initialName: string | null;
}) {
  const router = useRouter();
  const [email, setEmail] = useState(initialEmail ?? "");
  const [name, setName] = useState(initialName ?? "");
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const dirty = email.trim() !== (initialEmail ?? "") || name.trim() !== (initialName ?? "");

  async function save() {
    setBusy(true);
    setError(null);
    setStatus(null);
    try {
      const res = await fetch(`/api/prospects/${prospectId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ primary_contact_email: email, primary_contact_name: name }),
      });
      const d = await res.json();
      if (!res.ok) throw new Error(d.error || "Failed to save");
      setStatus("Saved.");
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to save");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="rounded-2xl bg-white p-5 shadow-soft">
      <p className="text-[11px] font-semibold uppercase tracking-[0.1em] text-brand-orange">Prospect contact</p>
      <p className="mt-1.5 text-xs text-muted-foreground">
        Add a contact to email the grant alert. Sending also adds them to the pipeline as a lead.
      </p>
      <div className="mt-2.5 space-y-2">
        <input
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="name@org.org"
          className="flex h-9 w-full rounded-md border border-input bg-card px-3 text-sm"
        />
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Contact name (optional)"
          className="flex h-9 w-full rounded-md border border-input bg-card px-3 text-sm"
        />
        <Button size="sm" className="w-full" disabled={busy || !dirty} onClick={save}>
          {busy ? "Saving…" : "Save contact"}
        </Button>
      </div>
      {status && <p className="mt-2 text-xs text-muted-foreground">{status}</p>}
      {error && <p className="mt-2 text-xs text-destructive">{error}</p>}
    </div>
  );
}
