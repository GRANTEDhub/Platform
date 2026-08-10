// Where a deep-linked client was actually headed, remembered across the first-login
// profile gate.
//
// THE PROBLEM THIS SOLVES. The alert email's portal band is a plain deep link
// (/portal/triage?card=...). app/portal/layout.tsx redirects an unconfirmed client to
// /welcome, and redirect() carries no return-to -- so a client clicking the alert for a
// specific grant confirmed their profile and landed on the dashboard, with the grant
// they clicked nowhere in sight. That is the exact path an alert email sends a brand-new
// client down, so it is the one case where losing the destination costs the most.
//
// WHY A COOKIE AND NOT A ?next= PARAM. The gate lives in a LAYOUT, and a Next App Router
// layout is not given the request pathname -- so the redirect literally cannot name where
// the client was going. Middleware is the only place in the request that sees the full
// URL before the layout renders. It sets this cookie on the way past; the confirm action
// reads and clears it. Nothing is threaded through the redirect at all.
//
// The alternative -- forwarding the path to the layout as a request header from
// middleware -- would mean rebuilding the NextResponse that lib/supabase/middleware.ts
// hands the Supabase cookie writer, and that plumbing is what refreshes the auth session.
// A response cookie set after the auth work is finished touches none of it.
//
// ── THREE EDGES, AND ALL THREE HAVE NOW BITTEN ──
//
// This cookie has produced the same class of bug three times: a page the client had merely
// LOADED became a destination they were sent to. The fixes live in three different files, so
// they are listed here, beside the cookie they all constrain:
//   1. WRITE. Only top-level document requests record a destination -- a prefetch is not a
//      destination (lib/supabase/middleware.ts, #336).
//   2. SANITISE. /portal/profile is never a destination; it is the form you just submitted
//      (sanitizePortalNext below, #336).
//   3. READ. Honoured only by the save that SATISFIES the gate -- a confirmed client editing
//      their profile had nothing swallowed, so there is nothing to restore
//      (app/portal/profile/actions.ts). Its absence sent an editing client to their grant
//      report, because loading the report is what wrote the cookie.
// Anything added here should say which of the three it touches.

import { safeNextPath } from "@/lib/safe-redirect";

export const PORTAL_NEXT_COOKIE = "granted_portal_next";

// Deliberately short. This means "where you were just heading," not a bookmark: a client
// who browsed the portal months ago and is only NOW un-exempted (staff nulling
// profile_confirmed_at) should not be dropped onto a stale grant from a previous session.
export const PORTAL_NEXT_MAX_AGE = 15 * 60; // seconds

// Same-origin PORTAL paths only. Validated on the way out as well as the way in: a cookie
// is client-supplied data, so honouring it unchecked would be an open redirect.
//
// Layered on safeNextPath rather than re-deriving the origin check -- that function already
// rejects the protocol-relative forms ("//evil.com", "/\evil.com") and is the same guard
// /auth/callback trusts. It falls back to "/", which fails the /portal test below, so a
// hostile value degrades to "no destination" rather than to the site root.
export function sanitizePortalNext(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const path = safeNextPath(raw);
  if (!path.startsWith("/portal")) return null;
  // Bare /portal is where confirming already lands, so it carries no information.
  if (path === "/portal" || path === "/portal/") return null;
  // NOR THE PROFILE PAGE, and this one is a loop rather than a no-op. /portal/profile mounts
  // the SAME ConfirmProfile form that /welcome does, so honouring it sends a client who just
  // confirmed their profile straight back into the profile form -- which reads as "the save
  // didn't take". The prefetch fix in lib/supabase/middleware.ts is what stopped this cookie
  // being written in the first place; this is the structural half, so the loop cannot return
  // through some other writer. A destination that is the form you just submitted is never
  // where you were going.
  if (path === "/portal/profile" || path.startsWith("/portal/profile/") || path.startsWith("/portal/profile?")) {
    return null;
  }
  return path;
}
