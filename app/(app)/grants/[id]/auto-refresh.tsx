"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";

/** Refreshes the server component on an interval while the grant is processing. */
export function AutoRefresh({ enabled, intervalMs = 4000 }: { enabled: boolean; intervalMs?: number }) {
  const router = useRouter();
  useEffect(() => {
    if (!enabled) return;
    const t = setInterval(() => router.refresh(), intervalMs);
    return () => clearInterval(t);
  }, [enabled, intervalMs, router]);
  return null;
}
