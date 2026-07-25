"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import type { IntellEngineDraftStatus } from "@/types/database";

// The "Continue" control shared by the IntellEngine flow steps (migration 0062).
// With a draft in context it advances the draft's status to `nextStatus` before
// moving on, and carries ?draft through so the whole flow stays tied to one
// proposal. Without a draft (staff previewing the mocked flow by hitting a step
// URL directly) it's just a plain link -- no persistence, nothing to fail.
export function ContinueButton({
  draftId,
  nextHref,
  nextStatus,
  children,
  className,
}: {
  draftId?: string;
  nextHref: string;
  nextStatus: IntellEngineDraftStatus;
  children: React.ReactNode;
  className: string;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);

  if (!draftId) {
    return (
      <Link href={nextHref} className={className}>
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
