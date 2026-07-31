"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";

// Mirrors the server action's result shape ("use server" modules may only export
// async functions).
type InviteState = {
  ok: boolean;
  error?: string;
  invited?: boolean;
  emailed?: boolean;
  emailSkippedReason?: string;
  recipient?: string;
};

// The last step of onboarding, in the client context bar next to the match button.
//
// Styled for a LIGHT surface. It used to be white-on-navy because its only home was
// the navy hero band; that band is gone, and this has exactly one caller, so there is
// no dark variant to keep -- a `tone` prop here would be a switch with one position.
//
// This is the RELEASE, not just an invite: client-facing alert sends are held until a
// portal seat exists, so pressing this both seats the client and opens the tap on the
// grants already reviewed for them. The confirm step exists because of that second
// effect -- "invite" undersells it, and it cannot be taken back.
export function InviteClientButton({
  clientName,
  contactEmail,
  action,
}: {
  clientName: string;
  contactEmail: string | null;
  action: () => Promise<InviteState>;
}) {
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<InviteState | null>(null);

  async function go() {
    if (busy) return;
    setBusy(true);
    const res = await action();
    setResult(res);
    setBusy(false);
    setConfirming(false);
  }

  if (result) {
    // Reports what actually happened. A held or failed email is never rendered as
    // "sent" -- this is the only feedback the action gives.
    return (
      <span className="rounded-full bg-page px-4 py-2 text-sm font-medium text-ink-muted ring-1 ring-edge">
        {!result.ok
          ? result.error ?? "Couldn't invite the client."
          : result.emailed
            ? `Invitation sent to ${result.recipient}`
            : result.invited
              ? `Seated — email not sent (${result.emailSkippedReason ?? "sending is disabled here"})`
              : result.error ?? "Not invited."}
      </span>
    );
  }

  if (!confirming) {
    return (
      <Button
        type="button"
        onClick={() => setConfirming(true)}
        className="rounded-full bg-brand-orange text-white hover:bg-brand-orange/90"
      >
        Invite client to portal
      </Button>
    );
  }

  return (
    <span className="flex flex-wrap items-center gap-2 rounded-full bg-page px-3 py-1.5 ring-1 ring-edge">
      <span className="text-xs text-ink-muted">
        {contactEmail
          ? `Email ${contactEmail} and release their reviewed grants?`
          : `No contact email on file for ${clientName} — add one first.`}
      </span>
      <Button
        type="button"
        size="sm"
        disabled={busy || !contactEmail}
        onClick={go}
        className="rounded-full bg-brand-orange text-white hover:bg-brand-orange/90"
      >
        {busy ? "Inviting…" : "Yes, invite"}
      </Button>
      <Button
        type="button"
        size="sm"
        variant="ghost"
        disabled={busy}
        onClick={() => setConfirming(false)}
        className="text-ink-muted hover:bg-brand-navy/[0.06]"
      >
        Cancel
      </Button>
    </span>
  );
}
