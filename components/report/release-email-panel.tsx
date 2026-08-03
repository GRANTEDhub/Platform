"use client";

import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { useRouter } from "next/navigation";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";

// "Send Email" release composer for an account-managed client. Opens on mount
// (driven from the "Release to client" dropdown), loads a default editable draft
// (GET), and on send RELEASES the card to the client's portal + emails a custom,
// plain-text note (no PDF) via POST /api/review/[cardId]/release-email. Modeled on
// the lead OutreachPanel: nothing auto-sends; the send routes through the outreach
// gate, so on preview it reports the gate reason instead of emailing a real client.
export function ReleaseEmailPanel({
  cardId,
  backHref,
  onClose,
}: {
  cardId: string;
  backHref: string;
  onClose: () => void;
}) {
  const router = useRouter();
  const [mounted, setMounted] = useState(false);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null); // release confirmation (send status)
  const [to, setTo] = useState("");
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");

  useEffect(() => setMounted(true), []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`/api/review/${cardId}/release-email`, { method: "GET" });
        const d = await res.json();
        if (!res.ok) throw new Error(d.error || "Failed to load draft");
        if (cancelled) return;
        setTo(d.to || "");
        setSubject(d.subject || "");
        setBody(d.body || "");
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : "Failed to load draft");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [cardId]);

  async function send() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/review/${cardId}/release-email`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ to, subject, body }),
      });
      const d = await res.json();
      if (!res.ok) throw new Error(d.error || "Failed to release");
      setDone(d.send_status || (d.sent ? `Email sent to ${d.to}.` : "Released."));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to release");
    } finally {
      setBusy(false);
    }
  }

  function backToQueue() {
    router.push(backHref);
    router.refresh();
  }

  if (!mounted) return null;

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      onClick={() => !busy && !done && onClose()}
    >
      <div
        className="max-h-[90vh] w-full max-w-2xl overflow-y-auto rounded-xl border bg-card p-5 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        {done ? (
          <div className="flex flex-col items-center gap-3 py-8 text-center">
            <span className="flex h-12 w-12 items-center justify-center rounded-full bg-emerald-50 text-2xl text-emerald-600">✓</span>
            <h2 className="font-serif text-lg font-semibold text-brand-navy">Released to the client</h2>
            <p className="max-w-sm text-sm text-muted-foreground">{done}</p>
            <Button className="mt-2" onClick={backToQueue}>
              Back to the queue
            </Button>
          </div>
        ) : (
          <>
            <h2 className="font-serif text-lg font-semibold text-brand-navy">Send email to the client</h2>
            <p className="mt-1 text-xs text-muted-foreground">
              Releases this grant to the client&apos;s portal and sends a custom note with the
              one-page alert attached. The portal link sends as a clickable link. Edit below, then send.
            </p>
            {loading ? (
              <div className="mt-6 flex items-center gap-2 py-8 text-sm text-muted-foreground">
                <Loader2 className="h-5 w-5 animate-spin text-brand-orange" /> Preparing the draft…
              </div>
            ) : (
              <div className="mt-4 space-y-3">
                <label className="block space-y-1">
                  <span className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">To</span>
                  <input
                    type="email"
                    value={to}
                    onChange={(e) => setTo(e.target.value)}
                    placeholder="name@org.org"
                    className="flex h-9 w-full rounded-md border border-input bg-card px-3 text-sm"
                  />
                </label>
                <label className="block space-y-1">
                  <span className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">Subject</span>
                  <input
                    value={subject}
                    onChange={(e) => setSubject(e.target.value)}
                    className="flex h-9 w-full rounded-md border border-input bg-card px-3 text-sm"
                  />
                </label>
                <label className="block space-y-1">
                  <span className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">Message</span>
                  <textarea
                    value={body}
                    onChange={(e) => setBody(e.target.value)}
                    rows={12}
                    className="flex w-full rounded-md border border-input bg-card px-3 py-2 text-sm leading-relaxed"
                  />
                </label>
              </div>
            )}
            {error && <p className="mt-3 text-sm text-destructive">{error}</p>}
            <div className="mt-4 flex justify-end gap-2">
              <Button variant="ghost" onClick={onClose} disabled={busy}>
                Cancel
              </Button>
              <Button onClick={send} disabled={busy || loading || !to.trim() || !body.trim()}>
                {/* The one-pager is rendered at send time when the card has no saved draft
                    yet, which can take up to a minute -- so the label says so rather than
                    leaving a dead-looking button. */}
                {busy ? "Releasing and attaching the one-pager…" : "Release & send"}
              </Button>
            </div>
          </>
        )}
      </div>
    </div>,
    document.body,
  );
}
