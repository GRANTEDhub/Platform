"use client";

import { useState, useTransition } from "react";
import { format, parseISO } from "date-fns";
import { Button } from "@/components/ui/button";
import { Input, Label } from "@/components/ui/input";
import { markDiscoveryScheduled } from "./actions";

// Scheduling controls on the lead detail page. Two jobs:
//  1) Surface the booking link (NEXT_PUBLIC_BOOKING_URL) so an admin can grab it.
//  2) One-click "mark discovery scheduled" -> writes a booked_call event, which
//     is the producer the discovery_scheduled read-side has been waiting for.
// No polling / no Google API -- the human confirms the booking they can already
// see land in the calendar. The mark is CUED by real signal: if the lead clicked
// the tokenized scheduling link, we show when, so the action follows a fact
// rather than memory. The button is always available (some leads book directly).
export function SchedulingPanel({
  leadId,
  bookingUrl,
  lastClickedAt,
  scheduled,
}: {
  leadId: string;
  bookingUrl: string | null;
  lastClickedAt: string | null; // ISO of most recent clicked_schedule_call
  scheduled: { at: string | null } | null; // present if a booked_call already exists
}) {
  const [pending, start] = useTransition();
  const [when, setWhen] = useState("");
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const clickedLabel = lastClickedAt ? safeFmt(lastClickedAt) : null;

  const mark = () => {
    setError(null);
    start(async () => {
      try {
        await markDiscoveryScheduled(leadId, when || null);
        setWhen("");
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
      /* clipboard blocked; the link is visible to copy manually */
    }
  };

  return (
    <div className="space-y-5 text-sm">
      {error && (
        <p className="rounded-md border border-destructive/40 bg-destructive/5 p-2 text-xs text-destructive">
          {error}
        </p>
      )}

      {/* Booking link */}
      <div className="space-y-2">
        <Label>Booking link</Label>
        {bookingUrl ? (
          <div className="flex gap-2">
            <Input readOnly value={bookingUrl} className="text-xs" onFocus={(e) => e.currentTarget.select()} />
            <Button type="button" size="sm" variant="outline" onClick={copy}>
              {copied ? "Copied" : "Copy"}
            </Button>
          </div>
        ) : (
          <p className="text-xs text-muted-foreground">
            No booking link configured (NEXT_PUBLIC_BOOKING_URL).
          </p>
        )}
      </div>

      {/* Discovery-call mark */}
      <div className="space-y-2">
        {scheduled ? (
          <div className="rounded-md border border-input bg-muted/40 p-2 text-xs text-muted-foreground">
            Discovery scheduled{scheduled.at ? ` for ${safeFmt(scheduled.at)}` : ""}. You can re-mark to
            record a reschedule.
          </div>
        ) : clickedLabel ? (
          <p className="text-xs text-muted-foreground">
            Clicked scheduling link on {clickedLabel} — booked?
          </p>
        ) : (
          <p className="text-xs text-muted-foreground">
            Mark once the lead has booked a discovery call.
          </p>
        )}

        <Label>Meeting date &amp; time (optional)</Label>
        <Input type="datetime-local" value={when} onChange={(e) => setWhen(e.target.value)} />
        <Button type="button" size="sm" disabled={pending} onClick={mark}>
          {pending ? "Saving…" : scheduled ? "Update discovery time" : "Mark discovery scheduled"}
        </Button>
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
