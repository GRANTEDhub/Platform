"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { DecisionConfirmation } from "./decision-confirmation";
import type { GrantSummary } from "@/app/api/review/[id]/route";

// Grant-alert send: the SINGLE send path for a client card. The draft (short
// editable text body + the one-page PDF) is generated once and SAVED; preview and
// send reuse that saved artifact, so what's reviewed is byte-for-byte what goes
// out. "Regenerate" replaces the saved draft (fresh LLM + render). Sending is also
// the card's approval -- on success it fires the same DecisionConfirmation the
// plain-text approve did.
export function AlertSend({
  cardId,
  sentAt,
  sentTo,
  contactName,
}: {
  cardId: string;
  sentAt?: string | null;
  sentTo?: string | null;
  contactName?: string | null;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [regenBusy, setRegenBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [to, setTo] = useState("");
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");
  const [rev, setRev] = useState(0); // cache-buster for the preview PDF after regenerate
  const [schedulingLink, setSchedulingLink] = useState(false); // prospect/lead: PDF carries a booking link
  const [priorEmailedAt, setPriorEmailedAt] = useState<string | null>(null); // soft "emailed this address before" flag
  const [summary, setSummary] = useState<GrantSummary | null>(null);

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
      setSchedulingLink(!!d.schedulingLink);
      setPriorEmailedAt(d.priorEmailedAt ?? null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load draft");
    } finally {
      setLoading(false);
    }
  }

  async function regenerate() {
    setRegenBusy(true);
    setError(null);
    setStatus(null);
    try {
      const res = await fetch(`/api/alerts/${cardId}/draft`, { method: "POST" });
      const d = await res.json();
      if (!res.ok) throw new Error(d.error || "Failed to regenerate");
      setTo(d.to || "");
      setSubject(d.subject || "");
      setBody(d.body || "");
      setPriorEmailedAt(d.priorEmailedAt ?? null);
      setRev((r) => r + 1); // force the preview link to fetch the new saved PDF
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to regenerate");
    } finally {
      setRegenBusy(false);
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
      // Refused as already-sent (a sent card stays sent, or a concurrent send won
      // the claim): show the reason and refresh so the card repaints to its
      // "✓ Alerted" state. No duplicate email went out.
      if (d.alreadySent) {
        setStatus(d.send_status ?? "Already sent — not re-sent.");
        router.refresh();
        return;
      }
      // Sending IS the approval: show the same confirmation screen as the
      // plain-text approve. On a not-sent outcome (blocked/preview) the decision
      // still recorded, so the summary is shown too -- surfacing "recorded, not sent".
      if (d.grant_summary) {
        setSummary(d.grant_summary as GrantSummary);
        return;
      }
      setStatus(d.send_status ?? (d.sent ? `Alert sent to ${d.to}.` : "Not sent."));
      if (d.sent) {
        setOpen(false);
        router.refresh();
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to send");
    } finally {
      setBusy(false);
    }
  }

  if (summary) return <DecisionConfirmation summary={summary} />;

  // Alerted state: a grant_alerts row is sent AND has a recorded recipient.
  // Guards on sentTo -- a sent row with no recipient is a data problem, not a
  // clean delivery, so it must not paint the sent state.
  const alerted = !!(sentTo && sentTo.trim());
  const sentDate = alerted && sentAt ? new Date(sentAt).toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric" }) : null;

  // Rendered inline inside the DecisionPanel (as its primary action, above
  // Reject) -- no outer card of its own.
  return (
    <>
      {alerted ? (
        <>
          <div className="flex items-start gap-2 rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2">
            <span className="font-bold text-emerald-700">✓</span>
            <p className="text-xs leading-relaxed text-emerald-800">
              <b>Alert sent{sentDate ? ` ${sentDate}` : ""}</b>
              <br />
              to {contactName ? `${contactName} · ` : ""}{sentTo}
            </p>
          </div>
          <div className="mt-2 flex gap-2">
            <Button className="flex-1" disabled title="Already alerted">
              ✓ Alerted
            </Button>
            <Button variant="outline" onClick={openModal} disabled={busy}>
              ↻ Regenerate
            </Button>
          </div>
        </>
      ) : (
        <Button className="w-full" onClick={openModal} disabled={busy}>
          Send grant alert
        </Button>
      )}
      {status && <p className="mt-2 text-xs text-muted-foreground">{status}</p>}
      {error && !open && <p className="mt-2 text-xs text-destructive">{error}</p>}

      {open && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
          onClick={() => !busy && !regenBusy && setOpen(false)}
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
                  {priorEmailedAt && (
                    <span className="text-[11px] text-amber-700">
                      You’ve emailed this address before {new Date(priorEmailedAt).toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric" })}.
                    </span>
                  )}
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
                <div className="flex items-center justify-between gap-3">
                  <a
                    href={`/api/alerts/${cardId}/pdf?rev=${rev}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-1.5 text-sm font-medium text-brand-orange hover:underline"
                  >
                    📎 grant-alert.pdf — preview attachment ↗
                  </a>
                  <Button variant="outline" size="sm" onClick={regenerate} disabled={busy || regenBusy}>
                    {regenBusy ? "Regenerating…" : "↻ Regenerate"}
                  </Button>
                </div>
                <p className="text-[11px] text-muted-foreground">
                  Preview and send use the same saved PDF. Regenerate to rebuild it with fresh copy.
                </p>
                {schedulingLink && (
                  <p className="text-[11px] text-muted-foreground">
                    The attached PDF includes a clickable “Schedule your discovery call” link.
                  </p>
                )}
              </div>
            )}

            {error && <p className="mt-3 text-sm text-destructive">{error}</p>}
            {/* Not-sent outcomes (allowlist-blocked / sending disabled) return HTTP
                200 and keep the modal open -- surface the status HERE so the admin
                sees it, not only in the outer card hidden behind the overlay. */}
            {status && <p className="mt-3 text-sm text-muted-foreground">{status}</p>}

            {alerted && (
              <p className="mt-3 rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-xs text-emerald-800">
                This alert was already sent. Regenerate rebuilds the draft for preview only — it won’t be re-sent.
              </p>
            )}

            <div className="mt-4 flex justify-end gap-2">
              <Button variant="ghost" onClick={() => setOpen(false)} disabled={busy || regenBusy}>Cancel</Button>
              <Button onClick={send} disabled={busy || loading || regenBusy || alerted || !to.trim() || !body.trim()} title={alerted ? "Already sent — cannot re-send" : undefined}>
                {busy ? "Sending…" : "Send alert"}
              </Button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
