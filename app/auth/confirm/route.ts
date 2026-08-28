import { NextResponse, type NextRequest } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { safeNextPath } from "@/lib/safe-redirect";
import { confirmFailureTarget } from "@/lib/auth/setup-redirect";
import type { EmailOtpType } from "@supabase/supabase-js";

/**
 * Completes magic-link / email-OTP sign-in for PKCE-flow clients. GoTrue's
 * {{ .ConfirmationURL }} (implicit flow) doesn't deliver a ?code= the way
 * callback/route.ts's exchangeCodeForSession expects, so the email template
 * links here instead with ?token_hash=&type=&next=. We verify the token_hash
 * server-side and set the session cookies (createClient is the SSR server
 * client; a Route Handler can write cookies), then redirect in.
 *
 * Companion to callback/route.ts, which still handles the OAuth ?code= exchange
 * -- this is additive and doesn't touch it. `type` is read from the query (the
 * template should send {{ .Type }}, e.g. "magiclink"/"recovery") so this route
 * works for whichever email flow points at it.
 */
export async function GET(request: NextRequest) {
  const { searchParams, origin } = new URL(request.url);
  const token_hash = searchParams.get("token_hash");
  const type = searchParams.get("type") as EmailOtpType | null;
  const next = safeNextPath(searchParams.get("next"));

  if (token_hash && type) {
    const supabase = createClient();
    const { error } = await supabase.auth.verifyOtp({ type, token_hash });
    if (!error) {
      return NextResponse.redirect(`${origin}${next}`);
    }
    // Deliberate logging (matches callback/route.ts): without it, an expired/
    // already-used token, a type mismatch, and everything else all look like the
    // same silent bounce -- in the browser AND our own server logs.
    console.error("auth confirm: verifyOtp failed", {
      type,
      status: error.status,
      name: error.name,
      message: error.message,
    });
  } else {
    console.error("auth confirm: missing token_hash or type", { url: request.url });
  }

  // Route the failure by the link's INTENT, not blindly to /login: a spent/expired SETUP
  // link (next -> /set-password) returns to the set-password page, whose no-session state
  // offers a self-serve resend, so an account that hasn't set a password can't be stranded
  // on the sign-in page. See lib/auth/setup-redirect.ts.
  return NextResponse.redirect(`${origin}${confirmFailureTarget(next)}`);
}
