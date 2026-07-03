// Preview/production send guard.
//
// Preview and production share ONE Supabase database, so a branch-preview deploy
// reads the same review_cards (and approved emails) as production. The guard
// therefore lives at the send-execution point and keys off VERCEL_ENV, which
// Vercel injects on every deployment and branch code cannot spoof. Real sends
// are allowed ONLY from production, ONLY when explicitly enabled, ONLY with a
// key present -- belt and suspenders, because a false positive here emails a
// real client from a test deploy.

export interface SendGate {
  ok: boolean;
  reason: string;
}

export function canSendEmail(): SendGate {
  if (process.env.VERCEL_ENV !== "production") {
    return {
      ok: false,
      reason: `non-production environment (VERCEL_ENV=${process.env.VERCEL_ENV ?? "unset"})`,
    };
  }
  if (process.env.EMAIL_SENDING_ENABLED !== "true") {
    return { ok: false, reason: "email sending disabled (EMAIL_SENDING_ENABLED is not 'true')" };
  }
  if (!process.env.RESEND_PLATFORM_API) {
    return { ok: false, reason: "RESEND_PLATFORM_API not configured" };
  }
  return { ok: true, reason: "production, sending enabled, key present" };
}

// Testing-mode recipient allowlist, independent of canSendEmail. When
// OUTREACH_SEND_ALLOWLIST is set and non-empty, ONLY listed recipients may
// actually receive outreach even though sending is globally enabled -- every
// other address is blocked. Empty/unset => no restriction (normal behavior), so
// clearing the env var later returns to full sending. Comma-separated,
// case-insensitive.
export function outreachAllowlist(): string[] {
  return (process.env.OUTREACH_SEND_ALLOWLIST ?? "")
    .split(",")
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
}

export function isRecipientAllowed(email: string | null | undefined): boolean {
  const list = outreachAllowlist();
  if (list.length === 0) return true; // no allowlist configured => unrestricted
  return list.includes((email ?? "").trim().toLowerCase());
}

// Combined gate for an outreach send to a specific recipient: the global send
// gate AND the testing-mode allowlist must both pass. Callers use the returned
// reason verbatim so a blocked send is honest about WHY (disabled vs. allowlist).
export function canSendOutreach(recipient: string | null | undefined): SendGate {
  const base = canSendEmail();
  if (!base.ok) return base;
  if (!isRecipientAllowed(recipient)) {
    return { ok: false, reason: "blocked — not on send allowlist (testing mode)" };
  }
  return base;
}
