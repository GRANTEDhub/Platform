import { NextResponse, type NextRequest } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { safeNextPath } from "@/lib/safe-redirect";

/** Exchanges the OAuth / PKCE code for a session, then redirects in. Email
 *  magic links now go through /auth/confirm (token_hash + verifyOtp) instead. */
export async function GET(request: NextRequest) {
  const { searchParams, origin } = new URL(request.url);
  const code = searchParams.get("code");
  const next = safeNextPath(searchParams.get("next"));

  if (code) {
    const supabase = createClient();
    const { error } = await supabase.auth.exchangeCodeForSession(code);
    if (!error) {
      return NextResponse.redirect(`${origin}${next}`);
    }
    // Logged deliberately: exchangeCodeForSession's failure reason (missing
    // verifier vs. an expired/already-used code vs. something else) was
    // previously invisible -- the redirect to /login looked identical either
    // way, in both the browser and our own server logs.
    console.error("auth callback: code exchange failed", {
      status: error.status,
      name: error.name,
      message: error.message,
    });
  } else {
    console.error("auth callback: no code in callback URL", { url: request.url });
  }

  return NextResponse.redirect(`${origin}/login?error=auth`);
}
