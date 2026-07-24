import { NextResponse, type NextRequest } from "next/server";
import { createClient } from "@/lib/supabase/server";

/** Exchanges the magic-link / OAuth code for a session, then redirects in. */
export async function GET(request: NextRequest) {
  const { searchParams, origin } = new URL(request.url);
  const code = searchParams.get("code");
  const next = searchParams.get("next") || "/";

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
