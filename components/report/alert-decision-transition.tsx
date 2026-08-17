"use client";

import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { SpinningMark } from "@/components/ui/spinning-mark";

// Full-screen branded transition shown after a CLIENT answers a Grant Alert (Interested /
// Pass) in the swipe deck (#12), replacing the old static "All caught up — you reviewed N
// grants" screen. The rotating GRANTED logomark is the shared SpinningMark loader — the same
// one the intake "Profile Created" transition uses — so this is decision text around the
// existing spinner, not a new one.
//
// TWO CONTINGENT LINES, mirroring the two established transitions (top label, mark, redirect
// note):
//   top   = the decision just made — "Added to Grant Report" (interested) / "Grant passed on" (passed)
//   below = where it is heading      — "Redirecting to grant alerts" (more pending) / "Redirecting to dashboard" (none left)
// Display only: the caller (SwipeDeck) owns the actual navigation after its own timer, so the
// two never disagree about which destination the text promises.
//
// Portal-rendered onto document.body at z-[100] so it covers the deck (and the SME banner)
// regardless of any clipping ancestor — the same pattern as complete-profile's FullScreen.
export function AlertDecisionTransition({
  decision,
  morePending,
}: {
  decision: "interested" | "passed";
  morePending: boolean;
}) {
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  if (!mounted) return null;

  const top = decision === "interested" ? "Added to Grant Report" : "Grant passed on";
  const below = morePending ? "Redirecting to grant alerts" : "Redirecting to dashboard";

  return createPortal(
    <div
      role="status"
      aria-live="polite"
      className="fixed inset-0 z-[100] flex flex-col items-center justify-center gap-6 bg-white px-6 text-center"
    >
      <h2 className="font-serif text-2xl font-semibold text-brand-navy">{top}</h2>
      <SpinningMark />
      <p className="text-sm text-muted-foreground">{below}</p>
    </div>,
    document.body,
  );
}
