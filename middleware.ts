import { type NextRequest } from "next/server";
import { updateSession } from "@/lib/supabase/middleware";

export async function middleware(request: NextRequest) {
  return await updateSession(request);
}

export const config = {
  matcher: [
    /*
     * Match all request paths except API routes and static/image assets.
     * API routes are excluded because they authenticate themselves (session
     * cookie, or CRON_SECRET for the cron route) — running the page-auth
     * redirect on them would 307 token-authed calls like /api/cron/ingest
     * to /login and the handler would never run.
     */
    "/((?!api|_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)",
  ],
};
