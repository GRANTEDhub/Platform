"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input, Label } from "@/components/ui/input";

const SELECT_CLASS = "flex h-10 w-full rounded-md border border-input bg-card px-3 py-2 text-sm";

// Draft-then-human-approve warm outreach. Draft is generated on demand from a
// grant hook, shown editable, and only sends on an explicit "Approve & send".
// Nothing auto-sends. The send routes through the production/EMAIL_SENDING_ENABLED
// gate, so on preview it reports the gate reason instead of sending.
type Draft = { subject: string; body: string; to: string; grantId: string | null; grantTitle: string | null };

export function OutreachPanel({
  leadId,
  hooks,
}: {
  leadId: string;
  hooks: { id: string; grantTitle: string }[];
}) {
  const router = useRouter();
  const [hookId, setHookId] = useState(hooks[0]?.id ?? "");
  const [draft, setDraft] = useState<Draft | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);

  if (hooks.length === 0) {
    return <p className="text-sm text-muted-foreground">No grant hook to draft outreach from.</p>;
  }

  async function generate() {
    setBusy(true);
    setError(null);
    setStatus(null);
    try {
      const res = await fetch(`/api/leads/${leadId}/draft-outreach`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ hookId: hookId || undefined }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Draft failed");
      setDraft({ subject: data.subject, body: data.body, to: data.to ?? "", grantId: data.grantId, grantTitle: data.grantTitle });
    } catch (e) {
      setError(e instanceof Error ? e.message : "Draft failed");
    } finally {
      setBusy(false);
    }
  }

  async function send() {
    if (!draft) return;
    setBusy(true);
    setError(null);
    setStatus(null);
    try {
      const res = await fetch(`/api/leads/${leadId}/send-outreach`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ to: draft.to, subject: draft.subject, body: draft.body, grantId: draft.grantId }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Send failed");
      if (data.sent) {
        setStatus(`Sent to ${data.to}.${data.stageAdvanced ? " Stage advanced to contacted." : ""}`);
        setDraft(null);
        router.refresh();
      } else {
        setStatus(`Not sent — ${data.reason}. (Draft kept.)`);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Send failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-3 text-sm">
      {error && (
        <p className="rounded-md border border-destructive/40 bg-destructive/5 p-2 text-xs text-destructive">{error}</p>
      )}
      {status && (
        <p className="rounded-md border border-input bg-muted/40 p-2 text-xs text-muted-foreground">{status}</p>
      )}

      {!draft ? (
        <div className="space-y-2">
          {hooks.length > 1 && (
            <select value={hookId} onChange={(e) => setHookId(e.target.value)} className={SELECT_CLASS}>
              {hooks.map((h) => (
                <option key={h.id} value={h.id}>
                  {h.grantTitle}
                </option>
              ))}
            </select>
          )}
          <Button type="button" size="sm" disabled={busy} onClick={generate}>
            {busy ? "Drafting…" : "Draft outreach"}
          </Button>
        </div>
      ) : (
        <div className="space-y-3">
          <p className="inline-block rounded-full bg-brand-orange/10 px-2 py-0.5 text-[11px] font-medium text-brand-orange">
            Draft — review before sending
          </p>
          <div className="space-y-1">
            <Label>To</Label>
            <Input
              value={draft.to}
              onChange={(e) => setDraft({ ...draft, to: e.target.value })}
              placeholder="recipient@org.org (required to send)"
            />
          </div>
          <div className="space-y-1">
            <Label>Subject</Label>
            <Input value={draft.subject} onChange={(e) => setDraft({ ...draft, subject: e.target.value })} />
          </div>
          <div className="space-y-1">
            <Label>Body</Label>
            <textarea
              value={draft.body}
              onChange={(e) => setDraft({ ...draft, body: e.target.value })}
              rows={12}
              className="flex w-full rounded-md border border-input bg-card px-3 py-2 text-sm leading-relaxed"
            />
          </div>
          <div className="flex gap-2">
            <Button type="button" size="sm" disabled={busy || !draft.to.trim()} onClick={send}>
              {busy ? "Sending…" : "Approve & send"}
            </Button>
            <Button type="button" size="sm" variant="ghost" disabled={busy} onClick={() => setDraft(null)}>
              Discard
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
