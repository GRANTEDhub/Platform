import { NextRequest, NextResponse } from "next/server";

// Shared cron authorization. Vercel Cron sends `Authorization: Bearer <CRON_SECRET>`
// automatically on scheduled invocations, so requiring it never breaks real runs.
//
// FAIL CLOSED in production: if CRON_SECRET is missing/empty OR the header does
// not match, return 401 -- a misconfiguration must NOT silently open these
// service-role routes to the public (they trigger paid LLM/API work). Outside
// production (local/preview) we only enforce when a secret is configured, so
// local dev without the env var still works; a preview that sets CRON_SECRET is
// held to the same bar as prod.
//
// Returns a 401 NextResponse when the request is unauthorized, or null when it
// may proceed. Callers: `const deny = cronDeny(req); if (deny) return deny;`
export function cronDeny(req: NextRequest): NextResponse | null {
  const cronSecret = process.env.CRON_SECRET;
  const isProd = process.env.VERCEL_ENV === "production";
  const authHeader = req.headers.get("authorization");

  if (isProd || cronSecret) {
    if (!cronSecret || authHeader !== `Bearer ${cronSecret}`) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
  }
  return null;
}
