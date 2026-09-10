"use client";

import { useState } from "react";
import { AlertSend } from "@/app/(app)/review/[id]/alert-send";
import { useOverdueGate } from "@/components/report/overdue-gate";

// Compact per-row "Alert" trigger for a prospect in the /intel IntellEngine Action box.
//
// It reuses the EXISTING prospect-alert flow via AlertSend's autoOpen path — the same pattern
// the account-managed ReleaseToClientBar dropdown uses (components/report/release-bar.tsx): the
// button mounts <AlertSend autoOpen>, which opens its document.body-portal modal immediately, so
// the alert drafts + sends OVER the page and never leaves /intel. onClose unmounts it. Everything
// under the modal — the draft/send routes, the cold-outreach PDF (no horizon, baked /go booking
// link) and email body, convert-to-lead, the admin gate, and the gate-first no-deliverable-email
// refusal — is the unchanged existing machinery.
//
// OVERDUE GATE: AlertSend's autoOpen effect opens the modal WITHOUT its internal useOverdueGate
// (that only wraps the inline trigger), so — exactly like ReleaseToClientBar — the click is gated
// HERE before the autoOpen mount, and AlertSend is passed no `overdue` prop (already gated). A
// closed / closing-today grant thus shows the "deadline passed" warning before an irreversible
// cold email; a live grant opens straight through (guard is a no-op unless isOverdue).
//
// Rendered ONLY for a not-yet-alerted prospect; an alerted row shows the "✓ Alerted" badge
// instead (derived from sentByCard, i.e. a sent grant_alerts row). The flip stays POST-SEND:
// AlertSend's own router.refresh() on a successful send re-derives sentByCard server-side, so the
// row repaints to the badge in place — this component is not rendered for the alerted row, so it
// unmounts. Admin-only holds because /intel/[id] is requireAdmin() and the routes re-gate.
export function ProspectAlertButton({
  cardId,
  sentAt,
  sentTo,
  contactName,
  daysLeft,
  deadlineLabel,
  backHref,
}: {
  cardId: string;
  sentAt: string | null;
  // From sentByCard.get(cardId)?.sentTo — undefined for the not-yet-alerted rows this renders on.
  // Passed through so the modal's already-sent guard reads correctly if the row was alerted in
  // another tab between render and click; the server send guard is the real backstop.
  sentTo?: string | null;
  contactName: string | null;
  // Overdue-gate inputs (grant-level; cardId is this prospect card). daysLeft null / > 0 means the
  // guard is a no-op and the modal opens straight through.
  daysLeft: number | null;
  deadlineLabel: string | null;
  backHref: string;
}) {
  const [open, setOpen] = useState(false);
  // archivable: false — this is a discovery prospect card, which /api/review/archive-closed excludes
  // (card_type='prospect'), so the gate shows the deadline warning WITHOUT the dead-end Archive button.
  const { guard, gate } = useOverdueGate(
    { cardId, daysLeft, deadlineLabel, backHref, archivable: false },
    "Send grant alert",
  );
  return (
    <>
      <button
        type="button"
        onClick={() => guard(() => setOpen(true))}
        className="shrink-0 rounded-full border border-brand-orange/40 px-2 py-0.5 text-[11px] font-semibold text-brand-orangeDeep transition-colors hover:bg-brand-orange/[0.06] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-orange/60"
      >
        Alert
      </button>
      {gate}
      {open && (
        <AlertSend
          autoOpen
          cardId={cardId}
          sentAt={sentAt}
          sentTo={sentTo}
          contactName={contactName}
          onClose={() => setOpen(false)}
        />
      )}
    </>
  );
}
