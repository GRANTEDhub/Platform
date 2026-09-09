// Client referral tracking (migration 0093): a client records "forwarded internally, awaiting response" +
// a free-text "sent to" note on their own card. Flag-gated (REFERRAL_TRACKING_ENABLED, global, default OFF)
// so it ships dark; the flag gates the SETTER (the portal button + the /api/review whitelist), never the
// display — a card that IS 'forwarded' shows its status regardless, so real data never hides.

export function referralTrackingEnabled(): boolean {
  return process.env.REFERRAL_TRACKING_ENABLED === "true";
}

// The status text a forwarded card shows. TEXT ONLY (colour-blind rule: the status is carried by words,
// never by colour). `forwardedTo` is the free-text recipient note; blank is tolerated — a forward with no
// name recorded is still a valid forward, just less specific. Three variants for the three surfaces:
//   · "portal" — the client's own DecisionBar / confirmation ("Forwarded internally to Jane …")
//   · "list"   — a card row in the Grant Report list, staff + portal ("Forwarded to Jane · awaiting …")
//   · "staff"  — the staff card detail, third-person ("Client forwarded internally to Jane …")
export function forwardedStatusLabel(
  forwardedTo: string | null | undefined,
  variant: "portal" | "list" | "staff",
): string {
  const to = forwardedTo?.trim();
  if (variant === "list") {
    return to ? `Forwarded to ${to} · awaiting response` : "Forwarded internally · awaiting response";
  }
  if (variant === "staff") {
    return to
      ? `Client forwarded internally to ${to} — awaiting response`
      : "Client forwarded this internally — awaiting response";
  }
  return to ? `Forwarded internally to ${to} — awaiting response` : "Forwarded internally — awaiting response";
}
