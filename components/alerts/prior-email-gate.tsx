"use client";

import type { ReOutreach } from "@/lib/alerts/send-core";

// Shared gate for a COLD re-contact: the recipient has been emailed before, so Send is
// locked until the sender makes a deliberate choice. Informational, never a hard block
// -- reaching a NEW person at a known org is fine; this catches re-hitting the SAME
// individual with a second first-contact intro. The parent owns what each choice does
// (unlock Send; swap the displayed body to the follow-up variant; tag the send's
// reOutreach). Used by both single-send and the batch modal so it reads identically.
// Renders nothing when there is no prior send. `import type` keeps this client-safe
// (the type is erased; send-core's server-only never enters the bundle).
export function PriorEmailGate({
  priorEmailedAt,
  priorCardId,
  value,
  onChange,
}: {
  priorEmailedAt: string | null;
  priorCardId: string | null;
  value: ReOutreach | null;
  onChange: (v: ReOutreach) => void;
}) {
  if (!priorEmailedAt) return null;
  const on = new Date(priorEmailedAt).toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric" });
  return (
    <div className="space-y-2 rounded-md border border-amber-300 bg-amber-50 px-3 py-2.5 text-xs text-amber-900">
      <p className="font-medium">
        You’ve emailed this address before on {on}.{" "}
        {priorCardId && (
          <a href={`/review/${priorCardId}`} target="_blank" rel="noopener noreferrer" className="underline">
            View the prior alert ↗
          </a>
        )}
      </p>
      <p>Choose how to proceed before sending:</p>
      <label className="flex items-start gap-2">
        <input type="radio" className="mt-0.5" checked={value === "acknowledged"} onChange={() => onChange("acknowledged")} />
        <span>Acknowledge and send the cold email anyway.</span>
      </label>
      <label className="flex items-start gap-2">
        <input type="radio" className="mt-0.5" checked={value === "follow_up"} onChange={() => onChange("follow_up")} />
        <span>Switch to a follow-up version — drops the first-contact intro, keeps the booking link.</span>
      </label>
    </div>
  );
}
