"use server";

import { createServiceClient } from "@/lib/supabase/server";
import { canSendOutreach } from "@/lib/email/guard";
import { sendSignInLinkEmail } from "@/lib/email/send";
import { generateClientSetupLink } from "@/lib/clients/portal-login";

// Self-serve "email me a sign-in link", shared by the login page and the set-password
// no-session state. This is the recovery path that closes the first-login dead end: a
// spent/expired setup link no longer strands a client -- they request a fresh one
// themselves. It mints the SAME one-time recovery link the staff "Send setup link" action
// does (generateClientSetupLink -> /auth/confirm?type=recovery&next=/set-password), so every
// emailed auth link lands on the set-password page and the system stays unambiguously
// password-based. It replaces the old client-side signInWithOtp "magic link", which depended
// on a Supabase email-template redirect we can't guarantee lands on set-password.
//
// SECURITY -- this runs UNAUTHENTICATED, so it must not be an account-enumeration or
// account-creation oracle:
//   (a) NEVER creates an account -- generateLink('recovery') requires an existing user and
//       throws for an unknown email, which we swallow. No user is created as a side effect.
//   (b) Returns the SAME generic result whether or not the email has an account, whether or
//       not the send was permitted, and whether or not it failed -- the response reveals
//       nothing about who has an account.
//   (c) Backstopped by canSendOutreach, so in testing only allowlisted inboxes receive mail,
//       and the gate is checked BEFORE minting so a blocked request never burns a token.
const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

export async function requestSignInLink(rawEmail: string): Promise<{ ok: true }> {
  const email = (rawEmail ?? "").trim().toLowerCase();
  if (EMAIL_RE.test(email)) {
    try {
      // Gate first, so a blocked send doesn't burn a one-time token that then sits unused
      // (mirrors sendClientSetupLink). A blocked gate is indistinguishable from success here.
      if (canSendOutreach(email).ok) {
        const admin = createServiceClient();
        const url = await generateClientSetupLink(admin, email); // throws for unknown email
        await sendSignInLinkEmail({ to: email, url });
      }
    } catch {
      // Swallow every failure -- unknown account, send error, anything. The response is
      // generic regardless, so a real error can never leak account existence.
    }
  }
  return { ok: true };
}
