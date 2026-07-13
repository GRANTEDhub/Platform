"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";

/**
 * Refreshes the current server component on an interval while `enabled`. Used
 * wherever a page shows a background job's live progress and needs to re-fetch
 * until it finishes: grant ingest/matching (grants/[id]) and a prospect's
 * one-time match (clients/[id]). The page must be dynamic so each refresh re-reads
 * fresh data; when the job completes the caller passes enabled=false and polling
 * stops.
 */
export function AutoRefresh({ enabled, intervalMs = 4000 }: { enabled: boolean; intervalMs?: number }) {
  const router = useRouter();
  useEffect(() => {
    if (!enabled) return;
    const t = setInterval(() => router.refresh(), intervalMs);
    return () => clearInterval(t);
  }, [enabled, intervalMs, router]);
  return null;
}
