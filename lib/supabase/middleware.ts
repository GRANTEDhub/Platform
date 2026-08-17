import { createServerClient, type CookieOptions } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";
import {
  PORTAL_NEXT_COOKIE,
  PORTAL_NEXT_MAX_AGE,
  sanitizePortalNext,
} from "@/lib/portal/next-destination";

type CookieToSet = { name: string; value: string; options: CookieOptions };

/**
 * Refreshes the Supabase auth session on every request and guards routes.
 * Unauthenticated users are redirected to /login; signed-in users hitting
 * /login are sent to the app.
 */
export async function updateSession(request: NextRequest) {
  let response = NextResponse.next({ request });

  const { pathname } = request.nextUrl;
  // Public (unauthenticated) surfaces: the auth callback, the tokenized
  // outbound-door landing (/go/[token]) and the public intake form (/intake).
  // Without /go here, tokenized scheduling links sent to logged-out prospects
  // would be redirected to /login. These pages do their own service-role work
  // and expose no admin data.
  //
  // Computed BEFORE touching Supabase at all -- not just before the redirect
  // check below. getUser() silently attempts a session refresh using whatever
  // cookies are present; if a stale/invalid refresh-token cookie is sitting in
  // the browser (leftover from an earlier session), that refresh fails and the
  // client library clears the auth cookies in response -- which also sweeps up
  // the PKCE code-verifier cookie a fresh /auth/callback exchange needs (same
  // name prefix). That silently broke every magic-link sign-in whenever an
  // unrelated stale cookie existed: the code exchange never got a chance to
  // run because its verifier was gone before the route handler even started.
  // /auth/callback has no use for an existing session anyway -- it's in the
  // business of creating a new one -- so it must never touch Supabase here.
  const isPublicAsset =
    pathname.startsWith("/auth") ||
    pathname.startsWith("/go") ||
    // The alert email's one-click decision landing. Same contract as /go: tokenized,
    // service-role, exposes no admin data -- and the whole point is that the client
    // does not have to sign in, so a /login redirect would defeat the feature.
    pathname.startsWith("/decide") ||
    pathname.startsWith("/intake") ||
    pathname.startsWith("/sign") ||
    pathname === "/favicon.ico";
  if (isPublicAsset) return response;

  // Remember THE DEEP LINK THAT PROMPTED SIGN-IN, so it survives the first-login gate in
  // app/portal/layout.tsx (a layout, so it cannot name where the client was going -- see
  // lib/portal/next-destination.ts). Middleware is the only place that sees the full URL, and
  // the cookie is set ONLY on the /login redirect below -- i.e. only when we bounce a
  // SIGNED-OUT client to sign in. That is exactly "arrived via a deep link that prompted
  // sign-in": a client following an alert email's /portal/triage?card=... link while logged
  // out lands here first, and the cookie carries that destination through /login and the
  // first-login gate to the confirm action, which honours it once.
  //
  // NOT written on the authenticated pass-through. A page a client loads while ALREADY signed
  // in is not a "prompted sign-in" destination -- nothing intercepted them -- so honouring it
  // post-welcome is wrong. That was the reported bug: a signed-in-but-unconfirmed client who
  // opened /portal/grants recorded it as their destination, and completing /welcome dropped
  // them on an empty grant report instead of the dashboard. Default is now the dashboard for
  // every path except a genuine sign-in-prompting deep link (the confirm action's `?? "/portal"`).
  //
  // PREFETCHES ARE NOT DESTINATIONS. React/Next PREFETCH a <Link> (an ordinary matched request
  // that, while signed out, also 302s to /login), so without this guard a prefetched link would
  // be recorded as the deep link. Keyed on the ABSENCE OF THE `RSC` HEADER, not `Next-Router-
  // Prefetch`: Next only sends the prefetch header for PrefetchKind.AUTO, so a later
  // `prefetch={true}` would silently reopen the hole; `RSC` is present on every client-side
  // router fetch (prefetch or navigation) and absent on a real document load.
  const isRouterFetch = request.headers.has("RSC");
  const portalNext = isRouterFetch ? null : sanitizePortalNext(pathname + request.nextUrl.search);
  const withPortalNext = <T extends NextResponse>(res: T): T => {
    if (portalNext) {
      res.cookies.set(PORTAL_NEXT_COOKIE, portalNext, {
        httpOnly: true,
        sameSite: "lax",
        secure: process.env.NODE_ENV === "production",
        path: "/",
        maxAge: PORTAL_NEXT_MAX_AGE,
      });
    }
    return res;
  };

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

    const isAuthRoute = pathname.startsWith("/login");

    if (!user && !isAuthRoute) {
      const url = request.nextUrl.clone();
      url.pathname = "/login";
      url.searchParams.set("redirectedFrom", pathname);
      return withPortalNext(NextResponse.redirect(url));
    }

    if (user && isAuthRoute) {
      const url = request.nextUrl.clone();
      url.pathname = "/";
      url.search = "";
      return NextResponse.redirect(url);
    }

    // Authenticated pass-through: a page loaded while signed in is NOT a prompted-sign-in
    // destination, so it is never recorded (see the note above the withPortalNext helper).
    return response;
  } catch (err) {
    // A transient Supabase/network failure should not take down every route.
    console.error("Auth middleware error:", err);
    return response;
  }
}
