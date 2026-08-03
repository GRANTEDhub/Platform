"use client";

import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { useRouter } from "next/navigation";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { PriorEmailGate } from "@/components/alerts/prior-email-gate";
import { DecisionConfirmation } from "./decision-confirmation";
import type { GrantSummary } from "@/app/api/review/[id]/route";
import type { ReOutreach } from "@/lib/alerts/send-core";
import { useOverdueGate, type OverdueGateConfig } from "@/components/report/overdue-gate";

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
  autoOpen = false,
  onClose,
  overdue,
}: {
  cardId: string;
  sentAt?: string | null;
  sentTo?: string | null;
  contactName?: string | null;
  // When true (used from the account-managed "Release to client" dropdown), open
  // the modal on mount and render NO inline trigger button -- the dropdown item is
  // the trigger. onClose fires when the modal is dismissed so the parent can reset.
  autoOpen?: boolean;
  onClose?: () => void;
  // Deadline context for the overdue confirmation, on the STANDALONE (prospect) path
  // only. Omitted when rendered from ReleaseToClientBar's dropdown, which already gated
  // the click — passing it there would prompt twice inside one workflow.
  overdue?: OverdueGateConfig;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [autoOpened, setAutoOpened] = useState(false);
  const { guard, gate } = useOverdueGate(
    overdue ?? { cardId, daysLeft: null, deadlineLabel: null, backHref: "" },
    "Send the grant alert",
  );
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
  // Cold re-contact gate: on a COLD send (prospect/lead) to an address we've emailed
  // before, Send is locked until the sender picks a path. "acknowledged" keeps the
  // cold body; "follow_up" swaps to the follow-up variant (composed server-side at
  // draft time). Warm client sends leave these null/false -> no gate, unchanged.
  const [isColdSend, setIsColdSend] = useState(false);
  const [priorCardId, setPriorCardId] = useState<string | null>(null);
  const [coldBody, setColdBody] = useState(""); // the first-contact body (default)
  const [followUpBody, setFollowUpBody] = useState<string | null>(null); // the follow-up swap
  const [reoutreach, setReoutreach] = useState<ReOutreach | null>(null);
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  // Auto-open once when driven from the dropdown (openModal fetches the draft).
  useEffect(() => {
    if (autoOpen && mounted && !autoOpened) {
      setAutoOpened(true);
      void openModal();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoOpen, mounted, autoOpened]);

  // Dismiss: close the modal and tell the parent (resets the dropdown's mode).
  function closeModal() {
    setOpen(false);
    onClose?.();
  }

  // The draft is generated server-side (LLM narrative + Chromium PDF); the route
  // caps at 60s. Bound the client fetch just above that so a slow / stuck render
  // surfaces a clear error instead of an indefinite "Preparing draft…".
  async function fetchDraft(method: "GET" | "POST") {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 75000);
    try {
      return await fetch(`/api/alerts/${cardId}/draft`, { method, signal: controller.signal });
    } finally {
      clearTimeout(timer);
    }
  }

  function draftError(e: unknown, fallback: string): string {
    if (e instanceof Error && e.name === "AbortError")
      return "The draft is taking longer than expected — please try again.";
    return e instanceof Error ? e.message : fallback;
  }

  async function openModal() {
    setError(null);
    setStatus(null);
    setOpen(true);
    setLoading(true);
    try {
      const res = await fetchDraft("GET");
      const d = await res.json();
      if (!res.ok) throw new Error(d.error || "Failed to load draft");
      setTo(d.to || "");
      setSubject(d.subject || "");
      setBody(d.body || "");
      setColdBody(d.body || "");
      setFollowUpBody(d.followUpBody ?? null);
      setIsColdSend(!!d.isColdSend);
      setPriorCardId(d.priorCardId ?? null);
      setReoutreach(null);
      setSchedulingLink(!!d.schedulingLink);
      setPriorEmailedAt(d.priorEmailedAt ?? null);
    } catch (e) {
      setError(draftError(e, "Failed to load draft"));
    } finally {
      setLoading(false);
    }
  }

  // The gate's choice both unlocks Send and picks which body goes out: the cold
  // first-contact body, or the follow-up variant (drops the intro + credential).
  // A no-op if followUpBody is missing (warm send -> gate never renders anyway).
  function chooseReoutreach(v: ReOutreach) {
    setReoutreach(v);
    setBody(v === "follow_up" && followUpBody != null ? followUpBody : coldBody);
  }

  async function regenerate() {
    setRegenBusy(true);
    setError(null);
    setStatus(null);
    try {
      const res = await fetchDraft("POST");
      const d = await res.json();
      if (!res.ok) throw new Error(d.error || "Failed to regenerate");
      setTo(d.to || "");
      setSubject(d.subject || "");
      setBody(d.body || "");
      setColdBody(d.body || "");
      setFollowUpBody(d.followUpBody ?? null);
      setIsColdSend(!!d.isColdSend);
      setPriorCardId(d.priorCardId ?? null);
      setReoutreach(null); // fresh cold body -> re-choose before sending
      setPriorEmailedAt(d.priorEmailedAt ?? null);
      setRev((r) => r + 1); // force the preview link to fetch the new saved PDF
    } catch (e) {
      setError(draftError(e, "Failed to regenerate"));
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
        body: JSON.stringify({ to, subject, body, reOutreach: reoutreach ?? undefined }),
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
  // A cold re-contact must resolve the gate (pick a path) before Send unlocks.
  const coldReContact = isColdSend && !!priorEmailedAt;

  // Rendered inline inside the DecisionPanel (as its primary action, above
  // Reject) -- no outer card of its own.
  return (
    <>
      {gate}
      {/* No inline trigger when driven from the dropdown (autoOpen) -- the menu item
          is the trigger and the modal opens on mount. */}
      {!autoOpen && (
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
                <Button variant="outline" onClick={() => guard(openModal)} disabled={busy}>
                  ↻ Regenerate
                </Button>
              </div>
            </>
          ) : (
            <Button className="w-full" onClick={() => guard(openModal)} disabled={busy}>
              Send grant alert
            </Button>
          )}
          {status && <p className="mt-2 text-xs text-muted-foreground">{status}</p>}
          {error && !open && <p className="mt-2 text-xs text-destructive">{error}</p>}
        </>
      )}

      {mounted && open && createPortal(
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
          onClick={() => !busy && !regenBusy && closeModal()}
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
              <div className="mt-6 flex flex-col items-center gap-3 py-8 text-center">
                <Loader2 className="h-6 w-6 animate-spin text-brand-orange" />
                <p className="text-sm font-medium text-brand-navy">Generating the draft…</p>
                <p className="text-xs text-muted-foreground">
                  Writing the note and rendering the one-page PDF — this can take up to a minute.
                </p>
              </div>
            ) : (
              <div className="mt-4 space-y-3">
                <label className="block space-y-1">
                  <span className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">To</span>
                  <input type="email" value={to} onChange={(e) => setTo(e.target.value)} placeholder="name@org.org"
                    className="flex h-9 w-full rounded-md border border-input bg-card px-3 text-sm" />
                  {/* Warm client: passive note. Cold (prospect/lead): the gate below
                      carries its own "emailed before" line + the required choice. */}
                  {priorEmailedAt && !isColdSend && (
                    <span className="text-[11px] text-amber-700">
                      You’ve emailed this address before {new Date(priorEmailedAt).toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric" })}.
                    </span>
                  )}
                </label>
                {/* Cold re-contact gate: renders only when this is a cold send AND the
                    address was emailed before (the component returns null otherwise).
                    Locks Send until a choice is made and swaps the body accordingly. */}
                {isColdSend && (
                  <PriorEmailGate
                    priorEmailedAt={priorEmailedAt}
                    priorCardId={priorCardId}
                    value={reoutreach}
                    onChange={chooseReoutreach}
                  />
                )}
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
              <Button variant="ghost" onClick={closeModal} disabled={busy || regenBusy}>Cancel</Button>
              <Button
                onClick={send}
                disabled={busy || loading || regenBusy || alerted || !to.trim() || !body.trim() || (coldReContact && !reoutreach)}
                title={alerted ? "Already sent — cannot re-send" : coldReContact && !reoutreach ? "Choose how to proceed with this re-contact first" : undefined}
              >
                {busy ? "Sending…" : "Send alert"}
              </Button>
            </div>
          </div>
        </div>,
        document.body,
      )}
    </>
  );
}
