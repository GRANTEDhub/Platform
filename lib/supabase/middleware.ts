import { createServerClient, type CookieOptions } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";

type CookieToSet = { name: string; value: string; options: CookieOptions };

/**
 * Refreshes the Supabase auth session on every request and guards routes.
 * Unauthenticated users are redirected to /login; signed-in users hitting
 * /login are sent to the app.
 */
export async function updateSession(request: NextRequest) {
  let response = NextResponse.next({ request });

  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

  // If Supabase isn't configured, don't 500 the entire site from middleware.
  // Let the request through; page-level guards (requireUser/requireAdmin) still
  // protect data, so this fails closed on protected pages, not open.
  if (!supabaseUrl || !supabaseAnonKey) {
    console.error("Auth middleware: Supabase env vars are not set");
    return response;
  }

  try {
    const supabase = createServerClient(supabaseUrl, supabaseAnonKey, {
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        setAll(cookiesToSet: CookieToSet[]) {
          cookiesToSet.forEach(({ name, value }) =>
            request.cookies.set(name, value),
          );
          response = NextResponse.next({ request });
          cookiesToSet.forEach(({ name, value, options }) =>
            response.cookies.set(name, value, options),
          );
        },
      },
    });

    // IMPORTANT: do not run code between createServerClient and getUser().
    const {
      data: { user },
    } = await supabase.auth.getUser();

    const { pathname } = request.nextUrl;
    const isAuthRoute = pathname.startsWith("/login");
    // Public (unauthenticated) surfaces: the auth callback, the tokenized
    // outbound-door landing (/go/[token]) and the public intake form (/intake).
    // Without /go here, tokenized scheduling links sent to logged-out prospects
    // would be redirected to /login. These pages do their own service-role work
    // and expose no admin data.
    const isPublicAsset =
      pathname.startsWith("/auth") ||
      pathname.startsWith("/go") ||
      pathname.startsWith("/intake") ||
      pathname.startsWith("/sign") ||
      pathname === "/favicon.ico";

    if (!user && !isAuthRoute && !isPublicAsset) {
      const url = request.nextUrl.clone();
      url.pathname = "/login";
      url.searchParams.set("redirectedFrom", pathname);
      return NextResponse.redirect(url);
    }

    if (user && isAuthRoute) {
      const url = request.nextUrl.clone();
      url.pathname = "/";
      url.search = "";
      return NextResponse.redirect(url);
    }

    return response;
  } catch (err) {
    // A transient Supabase/network failure should not take down every route.
    console.error("Auth middleware error:", err);
    return response;
  }
}
