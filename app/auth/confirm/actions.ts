"use server";

import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { safeNextPath } from "@/lib/safe-redirect";
import { confirmFailureTarget } from "@/lib/auth/setup-redirect";
import type { EmailOtpType } from "@supabase/supabase-js";

// Verifies the one-time email OTP — but ONLY from an explicit form POST (a human clicking
// "Continue" on the interstitial page), NEVER on a GET/HEAD of the email link.
//
// WHY THIS IS A POST AND NOT A GET HANDLER. Corporate email link scanners (Microsoft Safe
// Links / Proofpoint / Mimecast) prefetch every link in an email with GET/HEAD to detonate it
// before delivery. Next.js runs the GET route handler for HEAD requests too, so the old
// GET-verify route had the scanner's HEAD run verifyOtp and consume the SINGLE-USE recovery
// token ~1 second before the human clicked — and the real click then 403'd "Email link is
// invalid or has expired", every time (confirmed in prod runtime logs, the NWACC first-login
// incident: a HEAD /auth/confirm one second before each failing GET). A scanner does not submit
// forms, so gating verifyOtp behind this server action keeps the token intact until the person
// actually clicks Continue.
//
// On success we redirect to `next` (the session cookies are set on this response by the SSR
// client). On any failure we route by the link's intent via confirmFailureTarget — a setup link
// (next -> /set-password) returns to the set-password page and its self-serve resend, not the
// sign-in page. redirect() throws NEXT_REDIRECT by design; it is intentionally outside any catch.
export async function verifySetupLink(formData: FormData): Promise<void> {
  const token_hash = String(formData.get("token_hash") || "");
  const type = (String(formData.get("type") || "") || null) as EmailOtpType | null;
  const next = safeNextPath(String(formData.get("next") || ""));

  if (token_hash && type) {
    const supabase = createClient();
    const { error } = await supabase.auth.verifyOtp({ type, token_hash });
    if (!error) redirect(next);
    // Deliberate logging (matches the old route): an expired/already-used token, a type
    // mismatch, and everything else otherwise look like the same silent bounce.
    console.error("auth confirm: verifyOtp failed", {
      type,
      status: error.status,
      name: error.name,
      message: error.message,
    });
  } else {
    console.error("auth confirm: missing token_hash or type on verify");
  }

  redirect(confirmFailureTarget(next));
}
