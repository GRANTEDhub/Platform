"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";

// Grant-alert send: generate-on-Send -> preview the draft (short editable text
// body + the attached one-page PDF) -> confirm -> send. The PDF is rendered by
// the isolated Chromium route and previewed in a new tab; the send routes through
// the same allowlist gate as every other send.
export function AlertSend({ cardId }: { cardId: string }) {
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [to, setTo] = useState("");
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");

  async function openModal() {
    setError(null);
    setStatus(null);
    setOpen(true);
    setLoading(true);
    try {
      const res = await fetch(`/api/alerts/${cardId}/draft`);
      const d = await res.json();
      if (!res.ok) throw new Error(d.error || "Failed to load draft");
      setTo(d.to || "");
      setSubject(d.subject || "");
      setBody(d.body || "");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load draft");
    } finally {
      setLoading(false);
    }
  }

  async function send() {
    setBusy(true);
    setError(null);
    setStatus(null);
    try {
      const res = await fetch(`/api/alerts/${cardId}/send`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ to, subject, body }),
      });
      const d = await res.json();
      if (!res.ok) throw new Error(d.error || "Failed to send");
      setStatus(d.sent ? `Alert sent to ${d.to}.` : `Not sent — ${d.reason ?? "sending is off"}.`);
      if (d.sent) setOpen(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to send");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="rounded-2xl border border-brand-navy/10 bg-white p-4">
      <p className="text-[11px] font-semibold uppercase tracking-[0.1em] text-brand-orange">Grant alert</p>
      <p className="mt-1.5 text-xs text-muted-foreground">
        Send this client the branded one-page alert (PDF) with a short note.
      </p>
      <Button className="mt-2.5 w-full" onClick={openModal} disabled={busy}>
        Send grant alert
      </Button>
      {status && <p className="mt-2 text-xs text-muted-foreground">{status}</p>}
      {error && !open && <p className="mt-2 text-xs text-destructive">{error}</p>}

      {open && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
          onClick={() => !busy && setOpen(false)}
        >
          <div
            className="max-h-[90vh] w-full max-w-2xl overflow-y-auto rounded-xl border bg-card p-5 shadow-xl"
            onClick={(e) => e.stopPropagation()}
          >
            <h2 className="font-serif text-lg font-semibold text-brand-navy">Send grant alert</h2>
            <p className="mt-1 text-xs text-muted-foreground">
              The one-page alert PDF is attached. Review the note below, then send — or send as-is.
            </p>

            {loading ? (
              <p className="mt-4 text-sm text-muted-foreground">Preparing draft…</p>
            ) : (
              <div className="mt-4 space-y-3">
                <label className="block space-y-1">
                  <span className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">To</span>
                  <input type="email" value={to} onChange={(e) => setTo(e.target.value)} placeholder="name@org.org"
                    className="flex h-9 w-full rounded-md border border-input bg-card px-3 text-sm" />
                </label>
                <label className="block space-y-1">
                  <span className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">Subject</span>
                  <input value={subject} onChange={(e) => setSubject(e.target.value)}
                    className="flex h-9 w-full rounded-md border border-input bg-card px-3 text-sm" />
                </label>
                <label className="block space-y-1">
                  <span className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">Note</span>
                  <textarea value={body} onChange={(e) => setBody(e.target.value)} rows={7}
                    className="flex w-full rounded-md border border-input bg-card px-3 py-2 font-sans text-sm" />
                </label>
                <a
                  href={`/api/alerts/${cardId}/pdf`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1.5 text-sm font-medium text-brand-orange hover:underline"
                >
                  📎 grant-alert.pdf — preview attachment ↗
                </a>
              </div>
            )}

            {error && <p className="mt-3 text-sm text-destructive">{error}</p>}
            {/* Not-sent outcomes (allowlist-blocked / sending disabled) return HTTP
                200 and keep the modal open -- surface the status HERE so the admin
                sees it, not only in the outer card hidden behind the overlay. */}
            {status && <p className="mt-3 text-sm text-muted-foreground">{status}</p>}

            <div className="mt-4 flex justify-end gap-2">
              <Button variant="ghost" onClick={() => setOpen(false)} disabled={busy}>Cancel</Button>
              <Button onClick={send} disabled={busy || loading || !to.trim() || !body.trim()}>
                {busy ? "Sending…" : "Send alert"}
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
