"use client";

import { useState } from "react";

// The sign action: typed full name + explicit consent checkbox + Sign. Posts to
// /api/sign/[token]. On success the form is replaced by a confirmation. Nothing
// signs without both a name and the checked consent (also enforced server-side).
export function SignForm({ token }: { token: string }) {
  const [name, setName] = useState("");
  const [consent, setConsent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/sign/${token}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ signerName: name, consent }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Could not sign.");
      setDone(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not sign.");
    } finally {
      setBusy(false);
    }
  }

  if (done) {
    return (
      <div className="mt-6 rounded-lg border border-emerald-200 bg-emerald-50 p-4 text-sm text-emerald-800">
        <p className="font-medium">Signed — thank you.</p>
        <p className="mt-1">Your agreement is recorded. Your GRANTED contact will follow up on next steps.</p>
      </div>
    );
  }

  return (
    <div className="mt-6 space-y-4">
      {error && (
        <p className="rounded-md border border-red-300 bg-red-50 p-2 text-sm text-red-700">{error}</p>
      )}
      <div className="space-y-1">
        <label className="text-xs font-medium uppercase tracking-wide text-neutral-500">Full legal name</label>
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Type your full name"
          className="flex h-11 w-full rounded-md border border-neutral-300 bg-white px-3 py-2 text-sm"
        />
      </div>
      <label className="flex items-start gap-2 text-sm text-neutral-700">
        <input
          type="checkbox"
          checked={consent}
          onChange={(e) => setConsent(e.target.checked)}
          className="mt-1"
        />
        <span>
          I agree this constitutes my electronic signature and I intend to be legally bound by this
          agreement.
        </span>
      </label>
      <button
        type="button"
        disabled={busy || !name.trim() || !consent}
        onClick={submit}
        className="inline-block rounded-full bg-brand-orange px-6 py-3 text-sm font-medium text-brand-cream transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
      >
        {busy ? "Signing…" : "Sign agreement"}
      </button>
    </div>
  );
}
