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
  children,
  className,
}: {
  draftId?: string;
  nextHref: string;
  nextStatus?: Exclude<IntellEngineDraftStatus, "complete">;
  children: React.ReactNode;
  className: string;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);

  if (!draftId || !nextStatus) {
    // No draft, or no next screen to point at: navigate and write nothing.
    return (
      <Link href={draftId ? `${nextHref}?draft=${draftId}` : nextHref} className={className}>
        {children}
      </Link>
    );
  }

  async function go() {
    setBusy(true);
    try {
      await fetch(`/api/intellengine/drafts/${draftId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: nextStatus }),
      });
    } catch {
      // Non-fatal: keep moving even if the status write hiccups.
    }
    router.push(`${nextHref}?draft=${draftId}`);
  }

  return (
    <button type="button" onClick={go} disabled={busy} className={className}>
      {children}
    </button>
  );
}
