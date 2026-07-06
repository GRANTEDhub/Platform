"use client";

import { useState, useTransition } from "react";
import { format, parseISO } from "date-fns";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { markDiscoveryScheduled } from "./actions";

// Discovery scheduling on the lead detail page. The task is: send the prospect a
// standard invite (engagement flyer attached + scheduling link in the body) and
// let THEM book -- we don't set times. So the panel is one primary action:
//
//   "Send discovery invite" -> POST /api/leads/[id]/send-discovery-invite
//     (flyer attached, link in body, routed through the same allowlist gate as
//      every other send; logs discovery_invite_sent on a real send)
//
// Two de-emphasized secondaries stay for the manual edge cases: copy the raw
// scheduling link, and mark the discovery booked (no time -- the booking flag is
// the producer that flips the card to the "send contract" state). Once a real
// calendar/booking webhook exists, the manual mark can retire.
export function SchedulingPanel({
  leadId,
  bookingUrl,
  inviteSentAt,
  lastClickedAt,
  scheduled,
}: {
  leadId: string;
  bookingUrl: string | null;
  inviteSentAt: string | null; // ISO of most recent discovery_invite_sent
  lastClickedAt: string | null; // ISO of most recent clicked_schedule_call
  scheduled: { at: string | null } | null; // present if a booked_call already exists
}) {
  const router = useRouter();
  const [sending, startSend] = useTransition();
  const [marking, startMark] = useTransition();
  const [copied, setCopied] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const sendInvite = () => {
    setError(null);
    setStatus(null);
    startSend(async () => {
      try {
        const res = await fetch(`/api/leads/${leadId}/send-discovery-invite`, { method: "POST" });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || "Failed to send.");
        setStatus(
          data.sent ? `Invite sent to ${data.to}.` : `Not sent — ${data.reason ?? "sending is off"}.`,
        );
        router.refresh();
      } catch (e) {
        setError(e instanceof Error ? e.message : "Something went wrong.");
      }
    });
  };

  const mark = () => {
    setError(null);
    startMark(async () => {
      try {
        await markDiscoveryScheduled(leadId, null);
      } catch (e) {
        setError(e instanceof Error ? e.message : "Something went wrong.");
      }
    });
  };

  const copy = async () => {
    if (!bookingUrl) return;
    try {
      await navigator.clipboard.writeText(bookingUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard blocked; the link is still shown below to copy manually */
    }
  };

  const inviteLabel = inviteSentAt ? safeFmt(inviteSentAt) : null;
  const clickedLabel = lastClickedAt ? safeFmt(lastClickedAt) : null;

  return (
    <div className="space-y-4 text-sm">
      {error && (
        <p className="rounded-md border border-destructive/40 bg-destructive/5 p-2 text-xs text-destructive">
          {error}
        </p>
      )}

      {/* Primary: send the standard discovery invite. */}
      <div className="space-y-1.5">
        <Button type="button" disabled={sending} onClick={sendInvite}>
          {sending ? "Sending…" : inviteLabel ? "Resend discovery invite" : "Send discovery invite"}
        </Button>
        <p className="text-xs text-muted-foreground">
          Emails the contact the engagement flyer + a scheduling link so they can book.
        </p>
        {status && <p className="text-xs text-muted-foreground">{status}</p>}
        {inviteLabel && !status && (
          <p className="text-xs text-muted-foreground">Invite sent {inviteLabel}.</p>
        )}
      </div>

      {/* Status hint once we have signal from the lead. */}
      {scheduled ? (
        <p className="text-xs text-muted-foreground">
          Discovery booked{scheduled.at ? ` for ${safeFmt(scheduled.at)}` : ""}.
        </p>
      ) : clickedLabel ? (
        <p className="text-xs text-muted-foreground">Clicked the scheduling link on {clickedLabel}.</p>
      ) : null}

      {/* De-emphasized secondaries: copy the link, mark booked (no time). */}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 border-t border-brand-navy/[0.08] pt-3 text-xs text-muted-foreground">
        {bookingUrl && (
          <button type="button" onClick={copy} className="hover:text-brand-navy hover:underline">
            {copied ? "Link copied" : "Copy scheduling link"}
          </button>
        )}
        {!scheduled && (
          <button
            type="button"
            disabled={marking}
            onClick={mark}
            className="hover:text-brand-navy hover:underline disabled:opacity-50"
          >
            {marking ? "Marking…" : "Mark discovery booked"}
          </button>
        )}
      </div>
    </div>
  );
}

function safeFmt(v: string): string {
  try {
    return format(parseISO(v), "MMM d, h:mma");
  } catch {
    return v;
  }
}
