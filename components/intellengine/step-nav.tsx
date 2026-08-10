"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import type { IntellEngineDraftStatus } from "@/types/database";

// The "Continue" control shared by the IntellEngine flow steps (migration 0062).
// With a draft in context it moves the draft's RESUME POINTER to `nextStatus` before
// navigating, and carries ?draft through so the whole flow stays tied to one proposal.
// Without a draft (staff previewing the mocked flow by hitting a step URL directly) it's
// just a plain link -- no persistence, nothing to fail.
//
// IT ADVANCES A POINTER, NOT PROGRESS (0074). Whether a step's work is done is derived
// from the draft's content and stored nowhere, so this write records only where the
// client got to. `nextStatus` is optional for the same reason: the last screen in the
// flow has no next screen to point at, so it omits it and this is a plain navigation.
// It must never be given 'complete' -- the API rejects that, because a button click is
// exactly the wrong evidence that a proposal is finished.
export function ContinueButton({
  draftId,
  nextHref,
  nextStatus,
  beforeNavigate,
  children,
  className,
}: {
  draftId?: string;
  nextHref: string;
  nextStatus?: Exclude<IntellEngineDraftStatus, "complete">;
  // Persist-before-leaving. Return false to CANCEL the navigation -- the editors pass their
  // autosave flush, so a client whose save just failed stays on the page with their work and
  // the "Not saved" message in front of them instead of being carried onward without it.
  // This is the one thing the old fire-and-forget version got wrong that actually cost work.
  beforeNavigate?: () => Promise<boolean>;
  children: React.ReactNode;
  className: string;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);

  // A plain link only when there is nothing at all to do first. With a beforeNavigate to
  // await, it has to be a button even on the last screen of the flow.
  if ((!draftId || !nextStatus) && !beforeNavigate) {
    return (
      <Link href={draftId ? `${nextHref}?draft=${draftId}` : nextHref} className={className}>
        {children}
      </Link>
    );
  }

  async function go() {
    setBusy(true);

    // CONTENT FIRST, POINTER SECOND, and the order matters: if the client's work cannot be
    // saved there is no honest reason to record that they moved past this step.
    if (beforeNavigate) {
      const saved = await beforeNavigate();
      if (!saved) {
        // The editor's indicator is already showing why. Stay put.
        setBusy(false);
        return;
      }
    }

    if (draftId && nextStatus) {
      try {
        await fetch(`/api/intellengine/drafts/${draftId}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ status: nextStatus }),
        });
      } catch {
        // Still non-fatal, and now it is only the RESUME POINTER at stake -- a lost status
        // write means the client resumes one screen earlier, not that they lose anything.
      }
    }

    router.push(draftId ? `${nextHref}?draft=${draftId}` : nextHref);
  }

  return (
    <button type="button" onClick={go} disabled={busy} className={className}>
      {children}
    </button>
  );
}
