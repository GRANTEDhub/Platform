// Where /auth/confirm sends a visitor when an emailed link's one-time OTP fails to
// verify (already used, expired, or a mangled token). This is a trust-relevant routing
// decision, so it lives here as a pure function with its own test rather than inline in
// the route handler.
//
// THE BUG THIS FIXES: every emailed auth link (staff/client setup, and the self-serve
// sign-in link) is a SINGLE-USE recovery OTP. The first successful GET verifies it, sets a
// session, and lands on /set-password. Any second GET -- a human re-click, a browser
// prefetch, or a corporate email scanner (Safe Links / Proofpoint) pre-fetching the URL --
// finds the token spent and fails to verify. The old handler sent every such failure to
// /login?error=auth, i.e. the SIGN-IN page, which is exactly the wrong place for an account
// that has never set a password: it has no password to sign in with, and no way back to the
// setup page. It looked like a dead end.
//
// The fix keys on the link's INTENT (its `next`): a link headed for the set-password page is
// a setup / sign-in link, so a failed verify returns to /set-password -- whose no-session
// state offers a self-serve "email me a new sign-in link". So an account that hasn't finished
// setup ALWAYS lands on the setup page, however many times the link is clicked, until it's
// done. Everything else falls back to /login with the error flag as before.

export const SET_PASSWORD_PATH = "/set-password";

// `next` is already normalized by safeNextPath in the route (same-origin path, defaults to
// "/"), so we only classify it here. Match the set-password path exactly or with a trailing
// query / subpath, never a lookalike prefix like "/set-password-elsewhere".
export function confirmFailureTarget(next: string | null | undefined): string {
  const n = (next ?? "").trim();
  const isSetup =
    n === SET_PASSWORD_PATH ||
    n.startsWith(`${SET_PASSWORD_PATH}?`) ||
    n.startsWith(`${SET_PASSWORD_PATH}/`);
  return isSetup ? SET_PASSWORD_PATH : "/login?error=auth";
}
