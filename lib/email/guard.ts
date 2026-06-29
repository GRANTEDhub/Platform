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
