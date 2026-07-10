"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";

// Manual "Add to Client": pick an active client, Add, and the server scores the
// (grant, client) pair on demand and creates a card. Low fit is added silently;
// a SOFT block (engine suppression / grant-level skip_reason) offers an inline
// "Add anyway"; a HARD block (eligibility disqualification / ineligible funder)
// opens a warning dialog naming the specific reason before it can be forced.
// Overriding a soft block that then surfaces a hard one escalates to the dialog --
// a soft confirm can never blow past a hard warning the human never saw.
type ClientOption = { id: string; name: string };
type OverrideAck = "soft" | "hard";
type Block = { severity: OverrideAck; message: string };

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
  const [block, setBlock] = useState<Block | null>(null);

  async function run(override?: OverrideAck) {
    if (!clientId) return;
    setBusy(true);
    setMessage(null);
    try {
      const res = await fetch(`/api/grants/${grantId}/add-client`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ clientId, ...(override ? { override } : {}) }),
      });
      const data = await res.json();
      if (res.ok) {
        setBlock(null);
        setMessage({
          kind: "success",
          text: data.overridden
            ? `Added (manual override — engine fit ${data.fit_score}/3). Flagged for review.`
            : `Added — engine fit ${data.fit_score}/3.`,
        });
        setClientId("");
        router.refresh();
        return;
      }
      // Overridable block: surface the soft inline confirm or the hard dialog.
      // (Escalation: a soft "Add anyway" that hits a hard gate lands here again
      // with severity="hard" and swaps the inline confirm for the dialog.)
      if (res.status === 422 && data.overridable && (data.severity === "soft" || data.severity === "hard")) {
        setBlock({ severity: data.severity, message: data.error || "This match is blocked." });
        return;
      }
      // Terminal (non-overridable): international dead-stop, already-matched, etc.
      setBlock(null);
      setMessage({ kind: "error", text: data.error || "Failed to add." });
    } catch {
      setBlock(null);
      setMessage({ kind: "error", text: "Failed to add." });
    } finally {
      setBusy(false);
    }
  }

  function reset() {
    setBlock(null);
    setMessage(null);
  }

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2">
        <select
          value={clientId}
          onChange={(e) => {
            setClientId(e.target.value);
            reset();
          }}
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
        <Button size="sm" onClick={() => run()} disabled={busy || !clientId || block !== null}>
          {busy ? "Adding…" : "Add"}
        </Button>
      </div>

      {/* SOFT block — inline light confirm. */}
      {block?.severity === "soft" && (
        <div className="rounded-md border border-brand-orange/30 bg-brand-orange/[0.06] p-3">
          <p className="text-xs leading-relaxed text-foreground">{block.message}</p>
          <div className="mt-2 flex items-center gap-2">
            <Button
              size="sm"
              onClick={() => run("soft")}
              disabled={busy}
              className="bg-brand-orange text-white hover:bg-brand-orange/90"
            >
              {busy ? "Adding…" : "Add anyway"}
            </Button>
            <Button size="sm" variant="ghost" onClick={reset} disabled={busy}>
              Cancel
            </Button>
          </div>
        </div>
      )}

      {message && (
        <p className={`text-xs ${message.kind === "error" ? "text-destructive" : "text-muted-foreground"}`}>
          {message.text}
        </p>
      )}

      {/* HARD block — warning dialog. Reuses the app's modal pattern (fixed
          backdrop + card panel, click-outside to cancel). */}
      {block?.severity === "hard" && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
          onClick={() => (busy ? null : reset())}
        >
          <div
            className="w-full max-w-lg rounded-xl border bg-card p-5 shadow-xl"
            onClick={(e) => e.stopPropagation()}
          >
            <h2 className="font-serif text-lg font-semibold text-brand-navy">Eligibility warning</h2>
            <p className="mt-3 text-sm leading-relaxed text-foreground">{block.message}</p>
            <p className="mt-3 text-sm leading-relaxed text-muted-foreground">
              Forcing this creates a match for a grant the client may be legally ineligible to pursue as
              prime. Continue only if you know a partnership or subrecipient route the engine can&rsquo;t see.
              It will be flagged as a manual override.
            </p>
            <div className="mt-5 flex justify-end gap-2">
              <Button variant="ghost" onClick={reset} disabled={busy}>
                Cancel
              </Button>
              <Button
                onClick={() => run("hard")}
                disabled={busy}
                className="bg-brand-orange text-white hover:bg-brand-orange/90"
              >
                {busy ? "Adding…" : "Add anyway"}
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
